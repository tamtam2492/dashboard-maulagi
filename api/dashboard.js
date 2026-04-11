const { cors } = require('./_cors');
const { logError } = require('./_logger');
const { rateLimit } = require('./_ratelimit');
const { normalizeBankName } = require('./_bank');
const { getSupabase } = require('./_supabase');

const dashboardLimiter = rateLimit({ windowMs: 60 * 1000, max: 60 });
const DEFAULT_BATCH_SIZE = 1000;
const MAX_BATCH_SIZE = 2000;

function getBatchSize(req) {
  const requested = parseInt(req.query.batchSize, 10);
  if (!Number.isFinite(requested)) return DEFAULT_BATCH_SIZE;
  return Math.min(Math.max(requested, 100), MAX_BATCH_SIZE);
}

// Auto-cleanup: runs at most once per day, persisted in DB to avoid multi-instance double-run
function getOldestPeriode() {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth() - 2, 1);
  return d.toLocaleDateString('en-CA', { year: 'numeric', month: '2-digit' }).slice(0, 7);
}

async function runCleanup(supabase) {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Makassar' });
  const { data: setting } = await supabase
    .from('settings').select('value').eq('key', 'cleanup_last_run').maybeSingle();
  if (setting && setting.value === today) return;
  await supabase.from('settings').upsert({ key: 'cleanup_last_run', value: today });
  try {
    const oldest = getOldestPeriode();
    await supabase.from('transfers').delete().lt('periode', oldest);
    await supabase.from('noncod').delete().lt('periode', oldest);
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - 90);
    await supabase.from('visitors').delete().lt('tgl', cutoffDate.toLocaleDateString('en-CA'));
  } catch (err) {
    await supabase.from('settings').delete().eq('key', 'cleanup_last_run');
    console.error('Cleanup error:', err.message);
    logError('dashboard', err.message, { action: 'cleanup' });
  }
}

function normalizeProofUrl(buktiUrl) {
  let value = String(buktiUrl || '').trim();
  if (!value) return '';
  if (value.includes('drive.google.com')) {
    let fileId = null;
    const byId = value.match(/[?&]id=([^&]+)/);
    const byPath = value.match(/\/file\/d\/([^/]+)/);
    if (byId) fileId = byId[1];
    else if (byPath) fileId = byPath[1];
    if (fileId) return '/api/proxy-image?id=' + fileId;
  }
  if (!value.startsWith('http')) {
    return '/api/proxy-image?path=' + encodeURIComponent(value);
  }
  return value;
}

async function buildDashboardPayload(supabase, batchSize) {
  const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Makassar' });
  const rekapCabang = {};
  const todayCabang = new Set();
  const todayList = [];
  let totalNominal = 0;
  let transaksi = 0;
  let batchCount = 0;
  let from = 0;

  while (true) {
    const { data: rows, error } = await supabase
      .from('transfers')
      .select('timestamp, tgl_inputan, periode, nama_bank, nama_cabang, nominal, bukti_url, ket')
      .order('timestamp', { ascending: true })
      .range(from, from + batchSize - 1);

    if (error) throw error;
    if (!rows || rows.length === 0) break;

    batchCount += 1;
    transaksi += rows.length;

    for (const row of rows) {
      const nominal = parseFloat(row.nominal) || 0;
      if (nominal <= 0) continue;

      const cabang = (row.nama_cabang || 'Lainnya').trim();
      const bank = row.nama_bank ? normalizeBankName(row.nama_bank) : 'Lainnya';
      const tglRaw = row.tgl_inputan ? String(row.tgl_inputan).slice(0, 10) : null;
      const tgl = tglRaw ? tglRaw.split('-').reverse().map((value, index) => index === 2 ? value.slice(2) : value).join('/') : '-';
      const periode = row.periode || null;
      const buktiUrl = normalizeProofUrl(row.bukti_url);

      totalNominal += nominal;

      const tsDate = new Date(row.timestamp);
      const tsDateStr = tsDate.toLocaleDateString('en-CA', { timeZone: 'Asia/Makassar' });
      if (tsDateStr === todayStr) {
        todayCabang.add(cabang);
        const jamStr = tsDate.toLocaleTimeString('id-ID', { timeZone: 'Asia/Makassar', hour: '2-digit', minute: '2-digit' });
        todayList.push({ jam: jamStr, cabang, bank, nominal, bukti: buktiUrl, _ts: tsDate.getTime() });
      }

      if (!rekapCabang[cabang]) rekapCabang[cabang] = { total: 0, list: [] };
      rekapCabang[cabang].total += nominal;
      rekapCabang[cabang].list.push({ bank, nominal, tgl, tglRaw, periode, ket: row.ket || '-', bukti: buktiUrl, ts: row.timestamp });
    }

    if (rows.length < batchSize) break;
    from += batchSize;
  }

  if (transaksi === 0) {
    const now = new Date().toLocaleTimeString('id-ID', { timeZone: 'Asia/Makassar', hour: '2-digit', minute: '2-digit' });
    return {
      total: 0,
      transaksi: 0,
      todayCabang: 0,
      todayList: [],
      lastTransferTime: null,
      byCabang: {},
      lastUpdate: now,
      meta: { batched: true, batchSize, batchCount: 0, rowsProcessed: 0 },
    };
  }

  todayList.sort((a, b) => a._ts - b._ts);
  const lastTransferTime = todayList.length > 0 ? todayList[todayList.length - 1].jam : null;
  todayList.forEach(item => delete item._ts);
  const now = new Date().toLocaleTimeString('id-ID', { timeZone: 'Asia/Makassar', hour: '2-digit', minute: '2-digit' });

  return {
    total: totalNominal,
    transaksi,
    todayCabang: todayCabang.size,
    todayList,
    lastTransferTime,
    byCabang: rekapCabang,
    lastUpdate: now,
    meta: { batched: true, batchSize, batchCount, rowsProcessed: transaksi },
  };
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  if (cors(req, res)) return;
  if (await dashboardLimiter(req, res)) return;
  try {
    const supabase = getSupabase();
    const batchSize = getBatchSize(req);

    // Run daily cleanup (non-blocking)
    runCleanup(supabase).catch(() => {});

    return res.json(await buildDashboardPayload(supabase, batchSize));
  } catch (err) {
    console.error(err);
    logError('dashboard', err.message, { method: req.method });
    return res.status(500).json({ error: "Gagal memuat data. Periksa konfigurasi server." });
  }
};
