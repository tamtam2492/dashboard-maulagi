const { requireAdmin } = require('./_auth');
const { cors } = require('./_cors');
const { logError } = require('./_logger');
const { loginMaukirim, downloadOrdersWorkbook } = require('./_maukirim');
const { getSupabase } = require('./_supabase');
const { excelSerialToDate, loadWorkbookFromBuffer, worksheetToObjects } = require('./_excel');

function normalizeMethod(value) {
  const method = String(value || '').trim().toLowerCase();
  if (method === 'noncod' || method === 'dfod') return method;
  return '';
}

function createMetric() {
  return { grandOngkir: 0, grandTotal: 0, totalResi: 0, cabangCount: 0 };
}

const AUTO_SYNC_TTL_MS = 10 * 60 * 1000;
const MAUKIRIM_SYNC_KEY_PREFIX = 'maukirim_sync_';
const syncPendingByPeriode = new Map();

function canAutoSyncMaukirim() {
  return !!(process.env.MAUKIRIM_WA && process.env.MAUKIRIM_PASS);
}

function isAutoSyncablePeriode(periode) {
  const [year, month] = String(periode || '').split('-').map(Number);
  if (!year || !month) return false;
  const target = new Date(year, month - 1, 1);
  const now = new Date();
  const earliest = new Date(now.getFullYear(), now.getMonth() - 2, 1);
  const latest = new Date(now.getFullYear(), now.getMonth(), 1);
  return target >= earliest && target <= latest;
}

function getSyncSettingKey(periode) {
  return MAUKIRIM_SYNC_KEY_PREFIX + periode;
}

function normalizeSheetDate(val) {
  if (!val) return '';
  if (/^\d{4}-\d{2}-\d{2}/.test(String(val))) return String(val).slice(0, 10);
  if (val instanceof Date && !isNaN(val)) {
    const y = val.getFullYear();
    const m = String(val.getMonth() + 1).padStart(2, '0');
    const d = String(val.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  if (typeof val === 'number') {
    const parsedDate = excelSerialToDate(val);
    if (parsedDate) {
      return parsedDate.toISOString().slice(0, 10);
    }
  }
  const parsed = new Date(String(val));
  if (!isNaN(parsed) && parsed.getFullYear() > 2000) {
    const y = parsed.getFullYear();
    const m = String(parsed.getMonth() + 1).padStart(2, '0');
    const d = String(parsed.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  const parts = String(val).match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
  if (parts) return `${parts[3]}-${parts[2].padStart(2, '0')}-${parts[1].padStart(2, '0')}`;
  return String(val).slice(0, 30);
}

async function parseWorkbookRows(workbookBuffer) {
  const workbook = await loadWorkbookFromBuffer(workbookBuffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) return [];
  const rawRows = worksheetToObjects(sheet);
  return rawRows.map(r => ({
    tanggal_buat: normalizeSheetDate(r['Tanggal Buat']),
    tanggal_pickup: normalizeSheetDate(r['Tanggal Pickup']),
    tanggal_kirim: normalizeSheetDate(r['Tanggal Kirim']),
    tanggal_terima: normalizeSheetDate(r['Tanggal Terima']),
    status_terakhir: String(r['Status Terakhir'] || '').slice(0, 50),
    nama_pengirim: String(r['Nama Pengirim'] || '').slice(0, 200),
    kecamatan_pengirim: String(r['Kecamatan Pengirim'] || '').slice(0, 100),
    nama_penerima: String(r['Nama Penerima'] || '').slice(0, 200),
    provinsi_penerima: String(r['Provinsi Penerima'] || '').slice(0, 100),
    kab_kota_penerima: String(r['Kab/Kota Penerima'] || '').slice(0, 100),
    nomor_resi: String(r['Nomor Resi'] || '').slice(0, 50),
    ongkir: parseFloat(r['Ongkos Kirim']) || 0,
    total_pengiriman: parseFloat(r['Total Pengiriman']) || 0,
    metode_pembayaran: String(r['Metode Pembayaran'] || '').trim().toLowerCase().slice(0, 30),
    nama_ekspedisi: String(r['Nama Ekspedisi'] || '').slice(0, 50),
    cabang: String(r['Dibuat Oleh SubUser'] || '').slice(0, 100),
  }));
}

function sanitizeNoncodRows(periode, rows) {
  return rows.map(r => {
    const method = normalizeMethod(r.metode_pembayaran);
    return {
      periode,
      tanggal_buat: (r.tanggal_buat || '').slice(0, 30),
      tanggal_pickup: (r.tanggal_pickup || '').slice(0, 30),
      tanggal_kirim: (r.tanggal_kirim || '').slice(0, 30),
      tanggal_terima: (r.tanggal_terima || '').slice(0, 30),
      status_terakhir: (r.status_terakhir || '').slice(0, 50),
      nama_pengirim: (r.nama_pengirim || '').slice(0, 200),
      kecamatan_pengirim: (r.kecamatan_pengirim || '').slice(0, 100),
      nama_penerima: (r.nama_penerima || '').slice(0, 200),
      provinsi_penerima: (r.provinsi_penerima || '').slice(0, 100),
      kab_kota_penerima: (r.kab_kota_penerima || '').slice(0, 100),
      nomor_resi: (r.nomor_resi || '').slice(0, 50),
      ongkir: parseFloat(r.ongkir) || 0,
      total_pengiriman: parseFloat(r.total_pengiriman) || 0,
      metode_pembayaran: method,
      nama_ekspedisi: (r.nama_ekspedisi || '').slice(0, 50),
      cabang: (r.cabang || '').slice(0, 100),
    };
  }).filter(r => r.metode_pembayaran && (r.nomor_resi || r.ongkir > 0 || r.total_pengiriman > 0) && String(r.status_terakhir || '').trim().toUpperCase() !== 'BATAL');
}

function summarizeInsertedRows(rows) {
  return {
    noncod: rows.filter(r => r.metode_pembayaran === 'noncod').length,
    dfod: rows.filter(r => r.metode_pembayaran === 'dfod').length,
  };
}

async function replacePeriodeRows(supabase, periode, rows) {
  const { error: delErr } = await supabase.from('noncod').delete().eq('periode', periode);
  if (delErr) throw delErr;

  let inserted = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const batch = rows.slice(i, i + 500);
    if (!batch.length) continue;
    const { error: insErr } = await supabase.from('noncod').insert(batch);
    if (insErr) throw insErr;
    inserted += batch.length;
  }
  return inserted;
}

async function readSyncMeta(supabase, periode) {
  const { data } = await supabase
    .from('settings')
    .select('value')
    .eq('key', getSyncSettingKey(periode))
    .maybeSingle();
  if (!data || !data.value) return null;
  try {
    return JSON.parse(data.value);
  } catch {
    return null;
  }
}

async function writeSyncMeta(supabase, periode, meta) {
  await supabase.from('settings').upsert({
    key: getSyncSettingKey(periode),
    value: JSON.stringify(meta),
  });
}

async function maybeSyncMaukirimPeriod(supabase, periode) {
  const enabled = canAutoSyncMaukirim();
  const eligible = isAutoSyncablePeriode(periode);
  if (!enabled || !eligible) {
    return { enabled, eligible, performed: false, source: 'database' };
  }

  if (syncPendingByPeriode.has(periode)) {
    return syncPendingByPeriode.get(periode);
  }

  const currentMeta = await readSyncMeta(supabase, periode);
  const currentStamp = currentMeta && currentMeta.syncedAt ? Date.parse(currentMeta.syncedAt) : 0;
  if (currentStamp && (Date.now() - currentStamp) < AUTO_SYNC_TTL_MS) {
    return { enabled: true, eligible: true, performed: false, ...currentMeta };
  }

  const pending = (async () => {
    const cookies = await loginMaukirim();
    const workbookBuffer = await downloadOrdersWorkbook(cookies, periode);
    const importedRows = await parseWorkbookRows(workbookBuffer);
    const cleanRows = sanitizeNoncodRows(periode, importedRows);
    const inserted = await replacePeriodeRows(supabase, periode, cleanRows);
    const stats = summarizeInsertedRows(cleanRows);
    const meta = {
      source: 'maukirim_auto',
      syncedAt: new Date().toISOString(),
      inserted,
      stats,
    };
    await writeSyncMeta(supabase, periode, meta);
    return { enabled: true, eligible: true, performed: true, ...meta };
  })().finally(() => {
    syncPendingByPeriode.delete(periode);
  });

  syncPendingByPeriode.set(periode, pending);
  return pending;
}

async function fetchAllRowsByPeriode(supabase, periode) {
  const pageSize = 1000;
  let from = 0;
  const allRows = [];

  while (true) {
    const { data, error } = await supabase
      .from('noncod')
      .select('cabang, ongkir, total_pengiriman, nomor_resi, status_terakhir, tanggal_pickup, tanggal_buat, metode_pembayaran')
      .eq('periode', periode)
      .order('tanggal_buat', { ascending: true })
      .order('nomor_resi', { ascending: true })
      .range(from, from + pageSize - 1);

    if (error) throw error;
    if (!data || !data.length) break;

    allRows.push(...data);
    if (data.length < pageSize) break;
    from += pageSize;
  }

  return allRows;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (cors(req, res, { methods: 'GET, POST, DELETE, OPTIONS', headers: 'Content-Type, X-Admin-Token' })) return;

  // POST: admin only
  if (req.method === 'POST') {
    if (!(await requireAdmin(req, res))) return;
  }
  // DELETE: admin only
  if (req.method === 'DELETE') {
    if (!(await requireAdmin(req, res))) return;
  }

  const supabase = getSupabase();

  // GET /api/noncod?periode=2026-04 — ambil summary per cabang
  if (req.method === 'GET') {
    try {
      const periode = (req.query.periode || '').trim();
      const mode = String(req.query.mode || 'noncod').trim().toLowerCase();
      if (!periode || !/^\d{4}-\d{2}$/.test(periode)) {
        return res.status(400).json({ error: 'Parameter periode wajib (YYYY-MM).' });
      }
      if (!['noncod', 'dfod', 'all'].includes(mode)) {
        return res.status(400).json({ error: 'Mode tidak valid. Gunakan noncod, dfod, atau all.' });
      }

      let syncInfo = { enabled: canAutoSyncMaukirim(), eligible: isAutoSyncablePeriode(periode), performed: false, source: 'database' };
      try {
        syncInfo = await maybeSyncMaukirimPeriod(supabase, periode);
      } catch (syncErr) {
        console.error('[noncod sync]', syncErr.message);
        logError('noncod', syncErr.message, { method: 'GET', action: 'sync', periode });
        syncInfo = {
          enabled: canAutoSyncMaukirim(),
          eligible: isAutoSyncablePeriode(periode),
          performed: false,
          source: 'database',
          error: syncErr.message,
        };
      }

      const data = await fetchAllRowsByPeriode(supabase, periode);

      // Helper: normalize any date string to YYYY-MM-DD
      function toYMD(val) {
        if (!val) return '';
        const s = String(val).trim();
        // Already YYYY-MM-DD
        if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
        // Try JS Date parse (handles "07 Apr 2026", ISO, etc)
        const d = new Date(s);
        if (!isNaN(d.getTime()) && d.getFullYear() > 2000) {
          return d.toISOString().slice(0, 10);
        }
        // DD/MM/YYYY or DD-MM-YYYY
        const m = s.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
        if (m) return m[3] + '-' + m[2].padStart(2, '0') + '-' + m[1].padStart(2, '0');
        if (s) console.warn('[noncod] toYMD: format tanggal tidak dikenal:', s);
        return '';
      }

      const summary = {
        noncod: createMetric(),
        dfod: createMetric(),
        all: createMetric(),
      };
      const monthSummary = {
        noncod: createMetric(),
        dfod: createMetric(),
        all: createMetric(),
      };
      const summaryCabang = {
        noncod: new Set(),
        dfod: new Set(),
        all: new Set(),
      };
      const monthSummaryCabang = {
        noncod: new Set(),
        dfod: new Set(),
        all: new Set(),
      };

      // Group by cabang
      const byCabang = {};
      // Group by date then cabang (for daily view)
      const byDay = {};
      let grandOngkir = 0, grandTotal = 0, totalResi = 0;
      for (const row of (data || [])) {
        // Filter out cancelled shipments (BATAL)
        const statusRow = (row.status_terakhir || '').toUpperCase().trim();
        if (statusRow === 'BATAL') continue;
        const method = normalizeMethod(row.metode_pembayaran);
        if (!method) continue;
        const c = (row.cabang || '').trim();
        if (!c || c === '-') continue;
        const ongkir = parseFloat(row.ongkir) || 0;
        const total = parseFloat(row.total_pengiriman) || 0;
        const tgl = toYMD(row.tanggal_buat);
        const inActualMonth = !!(tgl && tgl.startsWith(periode + '-'));

        summary[method].grandOngkir += ongkir;
        summary[method].grandTotal += total;
        summary[method].totalResi += 1;
        summary[method].cabangCount = 0;
        summaryCabang[method].add(c);

        summary.all.grandOngkir += ongkir;
        summary.all.grandTotal += total;
        summary.all.totalResi += 1;
        summary.all.cabangCount = 0;
        summaryCabang.all.add(c);

        if (inActualMonth) {
          monthSummary[method].grandOngkir += ongkir;
          monthSummary[method].grandTotal += total;
          monthSummary[method].totalResi += 1;
          monthSummary[method].cabangCount = 0;
          monthSummaryCabang[method].add(c);

          monthSummary.all.grandOngkir += ongkir;
          monthSummary.all.grandTotal += total;
          monthSummary.all.totalResi += 1;
          monthSummary.all.cabangCount = 0;
          monthSummaryCabang.all.add(c);
        }

        const isIncluded = mode === 'all' || method === mode;
        if (!isIncluded) continue;

        if (!byCabang[c]) byCabang[c] = { ongkir: 0, total: 0, resi: 0 };
        byCabang[c].ongkir += ongkir;
        byCabang[c].total += total;
        byCabang[c].resi += 1;
        grandOngkir += ongkir;
        grandTotal += total;
        totalResi++;

        // Daily grouping by tanggal_buat (normalized to YYYY-MM-DD)
        if (tgl) {
          if (!byDay[tgl]) byDay[tgl] = {};
          if (!byDay[tgl][c]) byDay[tgl][c] = { ongkir: 0, resi: 0, total: 0 };
          byDay[tgl][c].ongkir += ongkir;
          byDay[tgl][c].resi += 1;
          byDay[tgl][c].total += total;
        }
      }

      summary.noncod.cabangCount = summaryCabang.noncod.size;
      summary.dfod.cabangCount = summaryCabang.dfod.size;
      summary.all.cabangCount = summaryCabang.all.size;
      monthSummary.noncod.cabangCount = monthSummaryCabang.noncod.size;
      monthSummary.dfod.cabangCount = monthSummaryCabang.dfod.size;
      monthSummary.all.cabangCount = monthSummaryCabang.all.size;

      return res.json({
        periode,
        mode,
        byCabang,
        byDay,
        grandOngkir,
        grandTotal,
        totalResi,
        totalCabang: Object.keys(byCabang).length,
        summary,
        monthSummary,
        syncInfo,
      });
    } catch (err) {
      console.error(err);
      logError('noncod', err.message, { method: 'GET' });
      return res.status(500).json({ error: 'Gagal memuat data noncod.' });
    }
  }

  // POST /api/noncod — upload batch data dari XLSX (parsed di client)
  if (req.method === 'POST') {
    try {
      const { periode, rows } = req.body || {};
      if (!periode || !/^\d{4}-\d{2}$/.test(periode)) {
        return res.status(400).json({ error: 'Periode wajib (YYYY-MM).' });
      }
      const [, mmPost] = periode.split('-');
      if (parseInt(mmPost) < 1 || parseInt(mmPost) > 12) {
        return res.status(400).json({ error: 'Bulan tidak valid.' });
      }
      if (!Array.isArray(rows) || rows.length === 0) {
        return res.status(400).json({ error: 'Data rows kosong.' });
      }
      if (rows.length > 10000) {
        return res.status(400).json({ error: 'Maksimal 10.000 baris per upload.' });
      }

      const clean = sanitizeNoncodRows(periode, rows);

      if (!clean.length) {
        return res.status(400).json({ error: 'File tidak berisi data NONCOD / DFOD valid yang bisa diproses.' });
      }

      const stats = summarizeInsertedRows(clean);
      const inserted = await replacePeriodeRows(supabase, periode, clean);
      await writeSyncMeta(supabase, periode, {
        source: 'manual_upload',
        syncedAt: new Date().toISOString(),
        inserted,
        stats,
      });

      return res.json({ success: true, inserted, periode, stats });
    } catch (err) {
      console.error(err);
      logError('noncod', err.message, { method: 'POST' });
      return res.status(500).json({ error: 'Gagal menyimpan data: ' + (err.message || err) });
    }
  }

  // DELETE /api/noncod?periode=2026-04 — hapus semua data periode
  if (req.method === 'DELETE') {
    try {
      const periode = (req.query.periode || '').trim();
      if (!periode || !/^\d{4}-\d{2}$/.test(periode)) {
        return res.status(400).json({ error: 'Parameter periode wajib (YYYY-MM).' });
      }
      const [, mmDel] = periode.split('-');
      if (parseInt(mmDel) < 1 || parseInt(mmDel) > 12) {
        return res.status(400).json({ error: 'Bulan tidak valid.' });
      }
      const { error } = await supabase.from('noncod').delete().eq('periode', periode);
      if (error) throw error;
      return res.json({ success: true });
    } catch (err) {
      console.error(err);
      logError('noncod', err.message, { method: 'DELETE' });
      return res.status(500).json({ error: 'Gagal menghapus data.' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed.' });
};
