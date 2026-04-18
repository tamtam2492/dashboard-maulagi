const { cors } = require('./_cors');
const { readAdminWriteMarker } = require('./_admin-write-marker');
const {
  BUSINESS_CLEANUP_LAST_RUN_KEY,
  getCleanupRunDate,
  getCleanupRunMonth,
  TEMPORARY_CLEANUP_LAST_RUN_KEY,
  runMaintenanceCleanup,
} = require('./_cleanup-maintenance');
const { logError } = require('./_logger');
const { rateLimit } = require('./_ratelimit');
const { normalizeBankName } = require('./_bank');
const { MK_HOST, httpReq, ckStr, loginMaukirim } = require('./_maukirim');
const { getSupabase } = require('./_supabase');

const dashboardLimiter = rateLimit({ windowMs: 60 * 1000, max: 60 });
const DEFAULT_BATCH_SIZE = 1000;
const MAX_BATCH_SIZE = 2000;
const MAUKIRIM_CACHE_TTL_MS = 60 * 1000;
const maukirimCache = {
  expiresAt: 0,
  orders: null,
  pending: null,
};

let vercelWaitUntil = null;
try {
  ({ waitUntil: vercelWaitUntil } = require('@vercel/functions'));
} catch {
  vercelWaitUntil = null;
}

function isVisitRequest(req) {
  return String(req.query.visit || '').trim() === '1';
}

function isUpdateCountRequest(req) {
  return String(req.query.update || '').trim() === '1';
}

function isMaukirimRequest(req) {
  return String(req.query.maukirim || '').trim() === '1';
}

function isWatchRequest(req) {
  return String(req.query.watch || '').trim() === '1';
}

function normalizeCabangName(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .replace(/^CABANG\s+/, '')
    .trim();
}

function getBatchSize(req) {
  const requested = parseInt(req.query.batchSize, 10);
  if (!Number.isFinite(requested)) return DEFAULT_BATCH_SIZE;
  return Math.min(Math.max(requested, 100), MAX_BATCH_SIZE);
}

async function runCleanup(supabase) {
  const today = getCleanupRunDate();
  const currentMonth = getCleanupRunMonth();

  const runScopedCleanup = async (settingKey, markerValue, cleanupOptions, scope) => {
    const { data: setting } = await supabase
      .from('settings').select('value').eq('key', settingKey).maybeSingle();
    if (setting && setting.value === markerValue) return;

    await supabase.from('settings').upsert({ key: settingKey, value: markerValue });

    try {
      await runMaintenanceCleanup(supabase, cleanupOptions);
    } catch (err) {
      await supabase.from('settings').delete().eq('key', settingKey);
      console.error('Cleanup error:', err.message);
      logError('dashboard', err.message, { action: 'cleanup', scope });
    }
  };

  await runScopedCleanup(
    TEMPORARY_CLEANUP_LAST_RUN_KEY,
    today,
    { includeBusinessData: false },
    'temporary',
  );

  await runScopedCleanup(
    BUSINESS_CLEANUP_LAST_RUN_KEY,
    currentMonth,
    { includeTemporaryData: false },
    'business',
  );
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

function parseOrders(html) {
  const orders = [];
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let match;
  while ((match = trRe.exec(html)) !== null) {
    const tds = match[1].match(/<td[^>]*>([\s\S]*?)<\/td>/gi);
    if (!tds || tds.length < 7) continue;
    const clean = (text) => text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const col1 = clean(tds[0]);
    if (!col1 || Number.isNaN(parseInt(col1, 10))) continue;
    const resiMatch = clean(tds[2]).match(/^(\S+)/);
    const cabangMatch = clean(tds[4]).match(/Dibuat oleh\s*:\s*(.+)/i);
    orders.push({
      no: parseInt(col1, 10),
      tanggal: clean(tds[1]),
      resi: resiMatch ? resiMatch[1] : clean(tds[2]),
      penerima: clean(tds[3]),
      ekspedisi: clean(tds[4]).split('Dibuat')[0].trim(),
      cabang: cabangMatch ? cabangMatch[1].trim() : '',
      total: clean(tds[5]),
      metode: clean(tds[6]).toLowerCase(),
      status: tds[7] ? clean(tds[7]) : '',
    });
  }
  return orders;
}

function getTwoMonthRange() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  const formatDate = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  return { date_start: formatDate(start), date_end: formatDate(end) };
}

async function fetchOrdersPage(cookies, page, dateRange) {
  const params = new URLSearchParams({
    date_start: dateRange.date_start,
    date_end: dateRange.date_end,
    date_by: 'created_at',
    page: String(page),
  });
  const response = await httpReq({
    hostname: MK_HOST,
    path: `/orders?${params.toString()}`,
    method: 'GET',
    headers: {
      'Cookie': ckStr(cookies),
      'User-Agent': 'Mozilla/5.0',
      'Accept': 'text/html',
      'Referer': `https://${MK_HOST}/orders`,
    },
  });
  return response.body;
}

async function fetchAllOrders(cookies) {
  const dateRange = getTwoMonthRange();
  const allOrders = [];
  let page = 1;
  const MAX_PAGES = 20;

  while (page <= MAX_PAGES) {
    const html = await fetchOrdersPage(cookies, page, dateRange);
    if (html.includes('Selamat Datang')) throw new Error('Session expired');
    const rows = parseOrders(html);
    if (rows.length === 0) break;
    allOrders.push(...rows);
    const hasNextPage = html.includes(`page=${page + 1}`);
    if (!hasNextPage) break;
    page += 1;
  }

  return allOrders;
}

async function getMaukirimOrders() {
  const now = Date.now();
  if (maukirimCache.orders && now < maukirimCache.expiresAt) {
    return maukirimCache.orders;
  }
  if (maukirimCache.pending) {
    return maukirimCache.pending;
  }

  maukirimCache.pending = (async () => {
    try {
      const cookies = await loginMaukirim();
      const orders = await fetchAllOrders(cookies);
      maukirimCache.orders = orders;
      maukirimCache.expiresAt = Date.now() + MAUKIRIM_CACHE_TTL_MS;
      return orders;
    } finally {
      maukirimCache.pending = null;
    }
  })();

  return maukirimCache.pending;
}

async function handleUpdateCountRoute(res) {
  try {
    const supabase = getSupabase();
    const { count, error } = await supabase
      .from('transfers')
      .select('id', { count: 'exact', head: true });
    if (error) throw error;
    return res.json(count || 0);
  } catch (err) {
    console.error(err);
    logError('check-update', err.message, { method: 'GET' });
    return res.status(500).json(0);
  }
}

async function handleMaukirimRoute(req, res) {
  const cabang = String(req.query.cabang || '').trim().toUpperCase();
  try {
    const all = await getMaukirimOrders();
    const cabangKey = normalizeCabangName(cabang);
    const filtered = cabangKey
      ? all.filter((order) => {
          const orderCabang = normalizeCabangName(order.cabang);
          return orderCabang.includes(cabangKey) || cabangKey.includes(orderCabang);
        })
      : all;
    return res.json({ ok: true, total: filtered.length, orders: filtered });
  } catch (err) {
    console.error('[maukirim]', err.message);
    return res.status(500).json({ error: err.message });
  }
}

async function handleWatchRoute(res) {
  try {
    const supabase = getSupabase();
    const marker = await readAdminWriteMarker(supabase);
    return res.json({ marker });
  } catch (err) {
    console.error(err);
    logError('dashboard-watch', err.message, { method: 'GET' });
    return res.status(500).json({ error: 'Gagal memuat marker workspace.' });
  }
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

async function handleVisitRoute(req, res) {
  try {
    const visitorId = String(req.query.vid || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
    if (!visitorId) return res.json({ today: 0 });

    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Makassar' });
    const supabase = getSupabase();

    const { data: existing } = await supabase
      .from('visitors')
      .select('id')
      .eq('tgl', today)
      .eq('visitor_id', visitorId)
      .maybeSingle();

    if (!existing) {
      await supabase.from('visitors').insert({ tgl: today, visitor_id: visitorId });
    }

    const { data: todayRows } = await supabase
      .from('visitors')
      .select('visitor_id')
      .eq('tgl', today);

    const uniqueCount = new Set((todayRows || []).map((row) => row.visitor_id)).size;
    return res.json({ today: uniqueCount });
  } catch (err) {
    logError('visit', err.message, { method: req.method });
    console.error(err);
    return res.status(500).json({ today: 0 });
  }
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  if (cors(req, res)) return;

  if (isVisitRequest(req)) {
    return handleVisitRoute(req, res);
  }

  if (isUpdateCountRequest(req)) {
    return handleUpdateCountRoute(res);
  }

  if (isMaukirimRequest(req)) {
    return handleMaukirimRoute(req, res);
  }

  if (isWatchRequest(req)) {
    return handleWatchRoute(res);
  }

  if (await dashboardLimiter(req, res)) return;
  try {
    const supabase = getSupabase();
    const batchSize = getBatchSize(req);

    // Run daily cleanup (non-blocking)
    const cleanupTask = runCleanup(supabase).catch(() => {});
    if (typeof vercelWaitUntil === 'function') vercelWaitUntil(cleanupTask);

    return res.json(await buildDashboardPayload(supabase, batchSize));
  } catch (err) {
    console.error(err);
    logError('dashboard', err.message, { method: req.method });
    return res.status(500).json({ error: "Gagal memuat data. Periksa konfigurasi server." });
  }
};
