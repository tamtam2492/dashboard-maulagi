const { requireAdmin, getViewerSession } = require('./_auth');
const { normalizeBankName } = require('./_bank');
const { cors } = require('./_cors');
const { logError } = require('./_logger');
const { loginMaukirim, downloadOrdersWorkbook } = require('./_maukirim');
const {
  aggregateOngkirByDate,
  findSequentialAllocationDates,
  getRecentPeriodes,
} = require('./_noncod-match');
const {
  deletePendingAllocation,
  listPendingAllocationRows,
  upsertPendingAllocation,
} = require('./_noncod-pending-allocations');
const {
  applyStatusOverrides,
  deleteStatusOverride,
  listStatusOverrideRows,
  readStatusOverridesByResi,
  upsertStatusOverride,
} = require('./_noncod-status-overrides');
const {
  getNoncodPipelineTriggerConfig,
  isNoncodPipelineTriggerEnabled,
  markNoncodSyncBuilding,
  markNoncodSyncFailed,
  markNoncodSyncPublished,
  markNoncodSyncQueued,
  normalizePeriodeList,
  queueNoncodPipelineTrigger,
  readNoncodSyncPipelineState,
  sendNoncodPipelineTrigger,
  timingSafeSecretEqual,
} = require('./_noncod-sync-pipeline');
const { publishAdminWriteMarker } = require('./_admin-write-marker');
const { getSupabase } = require('./_supabase');
const { excelSerialToDate, loadWorkbookFromBuffer, worksheetToObjects } = require('./_excel');
const {
  ensureAllowedMethod,
  normalizeBoundedInt,
  normalizeQueryFlag,
  normalizeText,
} = require('./_request-validation');
const { getPeriodeFromDate, normalizeTransferKet } = require('./_transfer-utils');

let vercelWaitUntil = null;
try {
  ({ waitUntil: vercelWaitUntil } = require('@vercel/functions'));
} catch {
  vercelWaitUntil = null;
}

const PERIODE_RE = /^\d{4}-\d{2}$/;
const EXCLUDED_NONCOD_STATUSES = new Set(['BATAL', 'VOID']);
const NONCOD_SYNC_COMPARE_FIELDS = [
  'periode',
  'tanggal_buat',
  'tanggal_pickup',
  'tanggal_kirim',
  'tanggal_terima',
  'status_terakhir',
  'nama_pengirim',
  'kecamatan_pengirim',
  'nama_penerima',
  'provinsi_penerima',
  'kab_kota_penerima',
  'nomor_resi',
  'ongkir',
  'total_pengiriman',
  'metode_pembayaran',
  'nama_ekspedisi',
  'cabang',
];

function normalizeMethod(value) {
  const method = String(value || '').trim().toLowerCase();
  if (method === 'noncod' || method === 'dfod') return method;
  return '';
}

function createMetric() {
  return { grandOngkir: 0, grandTotal: 0, totalResi: 0, cabangCount: 0 };
}

const MAUKIRIM_SYNC_KEY_PREFIX = 'maukirim_sync_';
const MAUKIRIM_AUTO_SYNC_INTERVAL_MS = 15 * 60 * 1000;
const NONCOD_BACKGROUND_REFRESH_COOLDOWN_MS = 60 * 1000;
const syncPendingByPeriode = new Map();

function scheduleNoncodBackgroundTask(task) {
  if (!task || typeof task.then !== 'function') return false;
  if (typeof vercelWaitUntil === 'function') {
    vercelWaitUntil(task);
    return true;
  }
  task.catch(() => {});
  return false;
}

function isValidPeriodeParam(periode) {
  const normalized = String(periode || '').trim();
  if (!PERIODE_RE.test(normalized)) return false;

  const month = Number(normalized.slice(5, 7));
  return Number.isInteger(month) && month >= 1 && month <= 12;
}

function hasPeriodeInList(periodes, periode) {
  const normalized = String(periode || '').trim();
  return Array.isArray(periodes) && periodes.includes(normalized);
}

function isNoncodPipelineRecentlyTriggered(pipelineState, now = Date.now()) {
  const lastTriggeredAt = String(pipelineState && pipelineState.lastTriggeredAt || '').trim();
  if (!lastTriggeredAt) return false;

  const triggeredAtMs = Date.parse(lastTriggeredAt);
  if (!Number.isFinite(triggeredAtMs)) return false;
  return now - triggeredAtMs < NONCOD_BACKGROUND_REFRESH_COOLDOWN_MS;
}

function planNoncodAutoRefresh(options = {}) {
  const periode = String(options.periode || '').trim();
  const syncInfo = options.syncInfo || {};
  const pipelineState = options.pipelineState || {};
  const rowCount = Math.max(0, Number(options.rowCount) || 0);
  const backgroundTriggerEnabled = !!options.backgroundTriggerEnabled;
  const forceSync = !!options.forceSync;
  const hasSyncMeta = !!options.syncMeta;
  const canRefresh = !!(syncInfo.enabled && syncInfo.eligible);
  const dirtyForPeriode = hasPeriodeInList(pipelineState.pendingPeriodes, periode);
  const buildingForPeriode = pipelineState.status === 'building'
    && (!Array.isArray(pipelineState.buildPeriodes)
      || !pipelineState.buildPeriodes.length
      || hasPeriodeInList(pipelineState.buildPeriodes, periode));

  if (!canRefresh) {
    return { action: 'none', status: 'idle', reason: '' };
  }

  if (forceSync) {
    return { action: 'inline', status: 'running', reason: 'force' };
  }

  if (!hasSyncMeta && rowCount === 0) {
    return { action: 'inline', status: 'running', reason: 'bootstrap_empty' };
  }

  if (buildingForPeriode) {
    return {
      action: 'none',
      status: 'running',
      reason: syncInfo.stale ? 'stale' : 'dirty',
    };
  }

  const needsRefresh = !!(syncInfo.stale || dirtyForPeriode);
  if (!needsRefresh) {
    return { action: 'none', status: 'idle', reason: '' };
  }

  const reason = dirtyForPeriode ? 'dirty' : 'stale';
  if (!backgroundTriggerEnabled) {
    return { action: 'inline', status: 'running', reason };
  }

  if (isNoncodPipelineRecentlyTriggered(pipelineState, options.now)) {
    return { action: 'none', status: 'queued', reason };
  }

  return { action: 'queue', status: 'queued', reason };
}

async function publishNoncodMarkerSafe(supabase, options, context) {
  try {
    await publishAdminWriteMarker(supabase, options || {});
  } catch (err) {
    logError('admin-marker', err.message, {
      method: context,
      action: 'publish_admin_write_marker',
      source: options && options.source,
      scopes: options && options.scopes,
      periodes: options && options.periodes,
    });
  }
}

function isExcludedNoncodStatus(value) {
  return EXCLUDED_NONCOD_STATUSES.has(String(value || '').trim().toUpperCase());
}

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

function formatPeriode(date) {
  return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0');
}

function getAutoSyncPeriods(referenceDate = new Date()) {
  const periods = [];
  const start = new Date(referenceDate.getFullYear(), referenceDate.getMonth() - 2, 1);
  for (let offset = 0; offset < 3; offset++) {
    periods.push(formatPeriode(new Date(start.getFullYear(), start.getMonth() + offset, 1)));
  }
  return periods;
}

function buildSyncInfo(periode, meta) {
  return {
    enabled: canAutoSyncMaukirim(),
    eligible: isAutoSyncablePeriode(periode),
    performed: false,
    source: meta && meta.source ? meta.source : 'database',
    syncedAt: meta && meta.syncedAt ? meta.syncedAt : null,
    inserted: meta && Number.isFinite(meta.inserted) ? meta.inserted : 0,
    delta: meta && meta.delta ? meta.delta : null,
    stats: meta && meta.stats ? meta.stats : null,
  };
}

function isSyncMetaStale(meta, now = Date.now()) {
  if (!meta || !meta.syncedAt) return true;
  const syncedAtMs = Date.parse(meta.syncedAt);
  if (!Number.isFinite(syncedAtMs)) return true;
  return now - syncedAtMs >= MAUKIRIM_AUTO_SYNC_INTERVAL_MS;
}

async function authorizeSyncRequest(req, res) {
  const expectedSecret = String(process.env.NONCOD_SYNC_SECRET || '').trim();
  const providedSecret = String(req.headers['x-sync-secret'] || '').trim();
  if (expectedSecret && providedSecret) {
    if (timingSafeSecretEqual(providedSecret, expectedSecret)) return true;
    res.status(401).json({ error: 'Unauthorized.' });
    return false;
  }
  if (!expectedSecret && providedSecret) {
    res.status(401).json({ error: 'Unauthorized.' });
    return false;
  }
  if (await requireAdmin(req, res)) return true;
  if (!res.body && !res.ended) {
    res.status(401).json({ error: 'Unauthorized.' });
  }
  return false;
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
  const seen = new Set();
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
  }).filter(r => {
    if (!r.metode_pembayaran) return false;
    if (!r.nomor_resi && r.ongkir <= 0 && r.total_pengiriman <= 0) return false;
    if (r.nomor_resi && seen.has(r.nomor_resi)) return false;
    if (r.nomor_resi) seen.add(r.nomor_resi);
    return true;
  });
}

function summarizeInsertedRows(rows) {
  return {
    noncod: rows.filter(r => r.metode_pembayaran === 'noncod').length,
    dfod: rows.filter(r => r.metode_pembayaran === 'dfod').length,
  };
}

function getNoncodSyncIdentity(row) {
  const nomorResi = String(row && row.nomor_resi || '').trim().toUpperCase();
  if (nomorResi) return 'resi:' + nomorResi;
  return 'fallback:' + [
    String(row && row.tanggal_buat || '').trim(),
    String(row && row.cabang || '').trim().toUpperCase(),
    String(row && row.nama_pengirim || '').trim().toUpperCase(),
    String(row && row.nama_penerima || '').trim().toUpperCase(),
    String(row && row.metode_pembayaran || '').trim().toLowerCase(),
    Number(row && row.ongkir || 0),
    Number(row && row.total_pengiriman || 0),
  ].join('|');
}

function normalizeComparableSyncValue(field, value) {
  if (field === 'ongkir' || field === 'total_pengiriman') return Number(value || 0);
  return String(value || '').trim();
}

function hasNoncodSyncRowChanged(existingRow, incomingRow) {
  return NONCOD_SYNC_COMPARE_FIELDS.some((field) => (
    normalizeComparableSyncValue(field, existingRow && existingRow[field])
    !== normalizeComparableSyncValue(field, incomingRow && incomingRow[field])
  ));
}

function planPeriodeRowReconciliation(existingRows, incomingRows) {
  const existingByIdentity = new Map();
  const duplicateIdsToDelete = [];

  for (const row of (existingRows || [])) {
    const identity = getNoncodSyncIdentity(row);
    if (existingByIdentity.has(identity)) {
      if (row && row.id != null) duplicateIdsToDelete.push(row.id);
      continue;
    }
    existingByIdentity.set(identity, row);
  }

  const rowsToInsert = [];
  const rowsToUpsert = [];
  let unchanged = 0;
  const seenIncomingIdentities = new Set();

  for (const row of (incomingRows || [])) {
    const identity = getNoncodSyncIdentity(row);
    if (seenIncomingIdentities.has(identity)) continue;
    seenIncomingIdentities.add(identity);

    const existingRow = existingByIdentity.get(identity);
    if (!existingRow) {
      rowsToInsert.push(row);
      continue;
    }

    if (hasNoncodSyncRowChanged(existingRow, row)) {
      rowsToUpsert.push({ id: existingRow.id, ...row });
    } else {
      unchanged += 1;
    }

    existingByIdentity.delete(identity);
  }

  const idsToDelete = duplicateIdsToDelete.concat(
    Array.from(existingByIdentity.values())
      .map((row) => row && row.id)
      .filter((id) => id != null)
  );

  return {
    rowsToInsert,
    rowsToUpsert,
    idsToDelete,
    inserted: rowsToInsert.length,
    updated: rowsToUpsert.length,
    deleted: idsToDelete.length,
    unchanged,
    total: Array.isArray(incomingRows) ? incomingRows.length : 0,
  };
}

async function fetchSyncRowsByPeriode(supabase, periode) {
  const pageSize = 1000;
  let from = 0;
  const allRows = [];

  while (true) {
    const { data, error } = await supabase
      .from('noncod')
      .select('id, periode, tanggal_buat, tanggal_pickup, tanggal_kirim, tanggal_terima, status_terakhir, nama_pengirim, kecamatan_pengirim, nama_penerima, provinsi_penerima, kab_kota_penerima, nomor_resi, ongkir, total_pengiriman, metode_pembayaran, nama_ekspedisi, cabang')
      .eq('periode', periode)
      .order('id', { ascending: true })
      .range(from, from + pageSize - 1);

    if (error) throw error;
    if (!data || !data.length) break;

    allRows.push(...data);
    if (data.length < pageSize) break;
    from += pageSize;
  }

  return allRows;
}

async function reconcilePeriodeRows(supabase, periode, rows) {
  const existingRows = await fetchSyncRowsByPeriode(supabase, periode);
  const plan = planPeriodeRowReconciliation(existingRows, rows);

  for (let i = 0; i < plan.rowsToUpsert.length; i += 500) {
    const batch = plan.rowsToUpsert.slice(i, i + 500);
    if (!batch.length) continue;
    const { error } = await supabase.from('noncod').upsert(batch, { onConflict: 'id' });
    if (error) throw error;
  }

  for (let i = 0; i < plan.rowsToInsert.length; i += 500) {
    const batch = plan.rowsToInsert.slice(i, i + 500);
    if (!batch.length) continue;
    const { error } = await supabase.from('noncod').insert(batch);
    if (error) throw error;
  }

  for (let i = 0; i < plan.idsToDelete.length; i += 200) {
    const batch = plan.idsToDelete.slice(i, i + 200);
    if (!batch.length) continue;
    const { error } = await supabase.from('noncod').delete().in('id', batch);
    if (error) throw error;
  }

  return plan;
}

async function buildPendingResolutionContext(supabase, cabang, periodes) {
  const { data: noncodRows, error: noncodError } = await supabase
    .from('noncod')
    .select('tanggal_buat, ongkir, metode_pembayaran, nomor_resi, status_terakhir')
    .in('periode', periodes)
    .eq('cabang', cabang);
  if (noncodError) throw noncodError;

  const overrideMap = await readStatusOverridesByResi(supabase, (noncodRows || []).map((row) => row.nomor_resi));
  const effectiveRows = applyStatusOverrides(noncodRows, overrideMap);
  const byDate = aggregateOngkirByDate(effectiveRows);
  const candidateDates = Object.keys(byDate);

  let existingTransfers = [];
  if (candidateDates.length) {
    const { data: transferRows, error: transferError } = await supabase
      .from('transfers')
      .select('id, tgl_inputan, nominal')
      .eq('nama_cabang', cabang)
      .in('tgl_inputan', candidateDates);
    if (transferError) throw transferError;
    existingTransfers = Array.isArray(transferRows) ? transferRows : [];
  }

  return { byDate, existingTransfers };
}

async function resolvePendingAllocations(supabase, options = {}) {
  const periodes = Array.isArray(options.periodes) && options.periodes.length
    ? [...new Set(options.periodes.map((periode) => String(periode || '').trim()).filter((periode) => isValidPeriodeParam(periode)))]
    : getRecentPeriodes();
  const { rows: pendingRows } = await listPendingAllocationRows(supabase);
  if (!pendingRows.length) return [];

  const contextCache = new Map();
  const results = [];
  const orderedRows = pendingRows
    .slice()
    .sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')) || a.cabang.localeCompare(b.cabang));

  for (const row of orderedRows) {
    const cacheKey = row.cabang + '|' + periodes.join(',');
    try {
      let context = contextCache.get(cacheKey);
      if (!context) {
        context = await buildPendingResolutionContext(supabase, row.cabang, periodes);
        contextCache.set(cacheKey, context);
      }

      const plan = findSequentialAllocationDates(
        context.byDate,
        context.existingTransfers,
        row.nominal,
        row.after_date,
        { includeStartDate: true },
      );
      if (!plan.dates.length) {
        results.push({
          root_transfer_id: row.root_transfer_id,
          resolvedNominal: 0,
          pendingNominal: row.nominal,
          inserted: [],
        });
        continue;
      }

      const insertRows = plan.dates.map((dateRow) => ({
        timestamp: row.timestamp || new Date().toISOString(),
        tgl_inputan: dateRow.tanggal_buat,
        periode: getPeriodeFromDate(dateRow.tanggal_buat),
        nama_bank: normalizeBankName(row.transfer_bank),
        nama_cabang: row.cabang,
        nominal: dateRow.plannedNominal,
        ket: normalizeTransferKet(row.ket) || null,
        bukti_url: row.bukti_url,
      }));

      const { data: insertedRows, error: insertError } = await supabase
        .from('transfers')
        .insert(insertRows)
        .select('id, tgl_inputan, nominal');
      if (insertError) throw insertError;

      const inserted = Array.isArray(insertedRows) ? insertedRows : [];

      try {
        if (plan.pendingNominal > 0) {
          await upsertPendingAllocation(supabase, {
            ...row,
            nominal: plan.pendingNominal,
            after_date: plan.lastDate || row.after_date,
            updated_at: new Date().toISOString(),
          });
        } else {
          await deletePendingAllocation(supabase, row.root_transfer_id);
        }
      } catch (pendingError) {
        if (inserted.length) {
          const rollbackResult = await supabase
            .from('transfers')
            .delete()
            .in('id', inserted.map((item) => item.id));
          if (rollbackResult.error) {
            logError('noncod-pending-allocation', rollbackResult.error.message, {
              method: 'RESOLVE',
              action: 'rollback_inserted_transfers',
              transferIds: inserted.map((item) => item.id),
            });
          }
        }
        throw pendingError;
      }

      inserted.forEach((item) => {
        context.existingTransfers.push({
          id: item.id,
          tgl_inputan: item.tgl_inputan,
          nominal: item.nominal,
        });
      });

      results.push({
        root_transfer_id: row.root_transfer_id,
        resolvedNominal: plan.allocatedTotal,
        pendingNominal: plan.pendingNominal,
        inserted,
      });
    } catch (err) {
      logError('noncod-pending-allocation', err.message, {
        method: 'RESOLVE',
        cabang: row.cabang,
        transferId: row.root_transfer_id,
      });
    }
  }

  return results;
}

async function deduplicateNoncodPeriode(supabase, periode) {
  let allRows = [];
  let from = 0;
  while (true) {
    const { data } = await supabase
      .from('noncod')
      .select('id, nomor_resi')
      .eq('periode', periode)
      .order('id', { ascending: true })
      .range(from, from + 999);
    if (!data || !data.length) break;
    allRows.push(...data);
    if (data.length < 1000) break;
    from += 1000;
  }

  const seen = new Set();
  const idsToDelete = [];
  for (const row of allRows) {
    const resi = row.nomor_resi || '';
    if (!resi) continue;
    if (seen.has(resi)) idsToDelete.push(row.id);
    else seen.add(resi);
  }

  if (!idsToDelete.length) return;

  for (let i = 0; i < idsToDelete.length; i += 200) {
    const batch = idsToDelete.slice(i, i + 200);
    await supabase.from('noncod').delete().in('id', batch);
  }
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

const SYNC_LOCK_TTL_MS = 90 * 1000;

async function acquireSyncLock(supabase, periode) {
  const lockKey = 'sync_lock_' + periode;
  const now = new Date().toISOString();

  // Atomic attempt: INSERT fails with 23505 if key already exists (unique idx_settings_key)
  const { error: insertErr } = await supabase
    .from('settings')
    .insert({ key: lockKey, value: now });
  if (!insertErr) return true;

  // Key exists — only take over if stale (conditional UPDATE = atomic)
  const staleThreshold = new Date(Date.now() - SYNC_LOCK_TTL_MS).toISOString();
  const { data: updated } = await supabase
    .from('settings')
    .update({ value: now })
    .eq('key', lockKey)
    .lt('value', staleThreshold)
    .select('key');
  return !!(updated && updated.length > 0);
}

async function releaseSyncLock(supabase, periode) {
  const lockKey = 'sync_lock_' + periode;
  await supabase.from('settings').delete().eq('key', lockKey);
}

async function maybeSyncMaukirimPeriod(supabase, periode, options = {}) {
  const enabled = canAutoSyncMaukirim();
  const eligible = isAutoSyncablePeriode(periode);
  const force = !!options.force;
  const currentMeta = await readSyncMeta(supabase, periode);
  if (!enabled || !eligible) {
    return buildSyncInfo(periode, currentMeta);
  }

  if (!force && currentMeta) {
    return buildSyncInfo(periode, currentMeta);
  }

  if (syncPendingByPeriode.has(periode)) {
    return syncPendingByPeriode.get(periode);
  }

  const locked = await acquireSyncLock(supabase, periode);
  if (!locked) {
    return buildSyncInfo(periode, currentMeta);
  }

  const pending = (async () => {
    const cookies = await loginMaukirim();
    const workbookBuffer = await downloadOrdersWorkbook(cookies, periode);
    const importedRows = await parseWorkbookRows(workbookBuffer);
    const cleanRows = sanitizeNoncodRows(periode, importedRows);
    const delta = await reconcilePeriodeRows(supabase, periode, cleanRows);
    const stats = summarizeInsertedRows(cleanRows);
    await resolvePendingAllocations(supabase, { periodes: getRecentPeriodes() });
    const meta = {
      source: 'maukirim_auto',
      syncedAt: new Date().toISOString(),
      inserted: cleanRows.length,
      delta: {
        inserted: delta.inserted,
        updated: delta.updated,
        deleted: delta.deleted,
        unchanged: delta.unchanged,
        total: delta.total,
      },
      stats,
    };
    await writeSyncMeta(supabase, periode, meta);
    return { enabled: true, eligible: true, performed: true, ...meta };
  })().finally(async () => {
    syncPendingByPeriode.delete(periode);
    await releaseSyncLock(supabase, periode).catch(() => {});
  });

  syncPendingByPeriode.set(periode, pending);
  return pending;
}

async function syncMaukirimPeriodes(supabase, periodes, options = {}) {
  const uniquePeriods = [...new Set((periodes || [])
    .map(periode => String(periode || '').trim())
    .filter(periode => isValidPeriodeParam(periode)))];
  const results = [];

  for (const periode of uniquePeriods) {
    const syncMeta = await readSyncMeta(supabase, periode);
    const baseInfo = buildSyncInfo(periode, syncMeta);

    if (!baseInfo.enabled || !baseInfo.eligible) {
      results.push({ periode, ...baseInfo, skipped: true });
      continue;
    }

    try {
      const syncInfo = await maybeSyncMaukirimPeriod(supabase, periode, { force: options.force !== false });
      results.push({ periode, ...syncInfo });
    } catch (err) {
      console.error('[noncod sync]', periode, err.message);
      logError('noncod', err.message, { method: 'CRON', action: 'sync', periode });
      results.push({ periode, ...baseInfo, error: err.message });
    }
  }

  return results;
}

function getRekonDateKey(row) {
  return normalizeSheetDate(row && row.tanggal_buat) || '';
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

async function handleManualStatusRoute(req, res) {
  if (!(await requireAdmin(req, res))) return true;
  const supabase = getSupabase();

  if (req.method === 'GET') {
    try {
      const result = await listStatusOverrideRows(supabase, {
        query: normalizeText(req.query.q, 160),
        limit: normalizeBoundedInt(req.query.limit, { fallback: 100, min: 1, max: 1000 }),
      });
      res.json(result);
      return true;
    } catch (err) {
      console.error(err);
      logError('noncod-status', err.message, { method: 'GET' });
      res.status(500).json({ error: 'Gagal memuat status manual resi.' });
      return true;
    }
  }

  if (req.method === 'PUT') {
    try {
      const override = await upsertStatusOverride(supabase, req.body || {});
      await publishNoncodMarkerSafe(supabase, {
        source: 'manual_status_put',
        scopes: ['noncod', 'manual_status', 'audit', 'admin_monitor'],
        periodes: override && override.periode ? [override.periode] : [],
      }, 'PUT');
      res.json({ success: true, override });
      return true;
    } catch (err) {
      console.error(err);
      const statusCode = /wajib diisi|tidak valid/i.test(err.message) ? 400 : 500;
      if (statusCode === 500) logError('noncod-status', err.message, { method: 'PUT' });
      res.status(statusCode).json({ error: err.message || 'Gagal menyimpan status manual.' });
      return true;
    }
  }

  if (req.method === 'DELETE') {
    try {
      const nomorResi = normalizeText(req.query.nomor_resi || req.body?.nomor_resi, 120);
      if (!nomorResi) {
        res.status(400).json({ error: 'Nomor resi wajib diisi.' });
        return true;
      }
      const existingOverrideMap = await readStatusOverridesByResi(supabase, [nomorResi]);
      const existingOverride = Array.from(existingOverrideMap.values())[0] || null;
      await deleteStatusOverride(supabase, nomorResi);
      await publishNoncodMarkerSafe(supabase, {
        source: 'manual_status_delete',
        scopes: ['noncod', 'manual_status', 'audit', 'admin_monitor'],
        periodes: existingOverride && existingOverride.periode ? [existingOverride.periode] : [],
      }, 'DELETE');
      res.json({ success: true });
      return true;
    } catch (err) {
      console.error(err);
      const statusCode = /tidak valid/i.test(err.message) ? 400 : 500;
      if (statusCode === 500) logError('noncod-status', err.message, { method: 'DELETE' });
      res.status(statusCode).json({ error: err.message || 'Gagal menghapus status manual.' });
      return true;
    }
  }

  res.status(405).json({ error: 'Method not allowed.' });
  return true;
}

async function handlePipelineRoute(req, res) {
  if (req.method === 'GET') {
    if (!(await requireAdmin(req, res))) return true;
    const supabase = getSupabase();
    const state = await readNoncodSyncPipelineState(supabase);
    const triggerConfig = getNoncodPipelineTriggerConfig();
    res.json({
      state,
      triggerEnabled: isNoncodPipelineTriggerEnabled(),
      triggerMode: triggerConfig.mode,
      triggerTarget: triggerConfig.url,
    });
    return true;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed.' });
    return true;
  }

  const authorized = await authorizeSyncRequest(req, res);
  if (!authorized) return true;

  const supabase = getSupabase();
  const triggerConfig = getNoncodPipelineTriggerConfig();

  const reason = normalizeText(req.body?.reason || 'background_sync', 120) || 'background_sync';
  const requestedPeriodes = normalizePeriodeList(req.body?.periodes)
    .filter((periode) => isValidPeriodeParam(periode));
  const force = req.body?.force !== false;

  try {
    if (!isNoncodPipelineTriggerEnabled()) {
      res.status(503).json({
        error: 'Lambda worker NONCOD belum dikonfigurasi.',
        triggerEnabled: false,
        triggerMode: triggerConfig.mode,
        triggerTarget: triggerConfig.url,
      });
      return true;
    }

    const queuedState = await markNoncodSyncQueued(supabase, {
      reason,
      periodes: requestedPeriodes.length ? requestedPeriodes : getAutoSyncPeriods(),
    });

    let triggerResult;
    try {
      triggerResult = await sendNoncodPipelineTrigger({
        reason,
        periodes: requestedPeriodes,
        source: 'noncod-pipeline-route',
        force,
      });
    } catch (triggerError) {
      triggerResult = {
        skipped: false,
        ok: false,
        status: 0,
        target: triggerConfig.url,
        error: triggerError && triggerError.message ? triggerError.message : 'trigger_failed',
      };
    }

    if (!triggerResult || !triggerResult.ok) {
      const triggerFailure = triggerResult && !triggerResult.skipped
        ? (triggerResult.error || (triggerResult.status ? ('HTTP ' + triggerResult.status) : 'trigger_failed'))
        : 'trigger_unavailable';
      const failedState = await markNoncodSyncFailed(supabase, {
        reason,
        periodes: requestedPeriodes,
        error: 'Trigger Lambda worker gagal: ' + triggerFailure,
      }).catch(() => null);
      logError('noncod-sync', 'Trigger Lambda worker gagal: ' + triggerFailure, {
        method: 'POST',
        action: 'trigger_lambda_worker',
        reason,
        periodes: requestedPeriodes,
        triggerTarget: triggerResult && triggerResult.target ? triggerResult.target : triggerConfig.url,
      });
      res.status(502).json({
        error: 'Gagal memicu Lambda worker NONCOD.',
        detail: triggerFailure,
        state: failedState,
        triggerEnabled: true,
        triggerMode: triggerConfig.mode,
        triggerTarget: triggerConfig.url,
      });
      return true;
    }

    res.status(202).json({
      success: true,
      status: queuedState.status,
      state: queuedState,
      triggerEnabled: true,
      triggerMode: triggerConfig.mode,
      triggerTarget: triggerResult.target || triggerConfig.url,
    });
    return true;
  } catch (err) {
    console.error(err);
    const failedState = await markNoncodSyncFailed(supabase, {
      reason,
      periodes: requestedPeriodes,
      error: err.message,
    }).catch(() => null);
    logError('noncod-sync', err.message, { method: 'POST', reason, periodes: requestedPeriodes });
    res.status(500).json({
      error: 'Gagal menjalankan background sync NONCOD.',
      detail: err.message,
      state: failedState,
    });
    return true;
  }
}

async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (cors(req, res, { methods: 'GET, POST, PUT, DELETE, OPTIONS', headers: 'Content-Type, X-Admin-Token, X-Sync-Secret' })) return;
  if (!ensureAllowedMethod(req, res, ['GET', 'POST', 'PUT', 'DELETE'])) return;

  const isManualStatusRoute = normalizeQueryFlag(req.query.manual_status);
  const isPipelineRoute = normalizeQueryFlag(req.query.pipeline);

  // DELETE: admin only
  if (req.method === 'DELETE' && !isManualStatusRoute) {
    if (!(await requireAdmin(req, res))) return;
  }

  if (isManualStatusRoute) {
    if (await handleManualStatusRoute(req, res)) return;
  }

  if (isPipelineRoute) {
    if (await handlePipelineRoute(req, res)) return;
  }

  // GET /api/noncod?periode=2026-04 — ambil summary per cabang
  if (req.method === 'GET') {
    try {
      const supabase = getSupabase();
      const periode = normalizeText(req.query.periode, 20);
      const mode = normalizeText(req.query.mode || 'noncod', 20).toLowerCase();
      const forceSync = normalizeQueryFlag(req.query.sync) || normalizeQueryFlag(req.query.refresh);
      if (!periode || !isValidPeriodeParam(periode)) {
        return res.status(400).json({ error: 'Parameter periode wajib (YYYY-MM) dengan bulan 01-12.' });
      }
      if (!['noncod', 'dfod', 'all'].includes(mode)) {
        return res.status(400).json({ error: 'Mode tidak valid. Gunakan noncod, dfod, atau all.' });
      }
      if (forceSync && !(await requireAdmin(req, res))) return;

      // Cek viewer session lebih awal — viewer hanya baca snapshot DB
      const viewerSession = await getViewerSession(req);
      const viewerCabang = viewerSession ? viewerSession.cabang : null;

      const syncMeta = await readSyncMeta(supabase, periode);
      const pipelineState = await readNoncodSyncPipelineState(supabase);
      const backgroundTriggerEnabled = isNoncodPipelineTriggerEnabled();
      const triggerConfig = getNoncodPipelineTriggerConfig();
      let syncInfo = buildSyncInfo(periode, syncMeta);
      syncInfo.pipeline = pipelineState;
      syncInfo.triggerEnabled = backgroundTriggerEnabled;
      syncInfo.triggerMode = triggerConfig.mode;
      syncInfo.triggerTarget = triggerConfig.url;
      syncInfo.stale = isSyncMetaStale(syncMeta);
      syncInfo.refreshState = { action: 'none', status: 'idle', reason: '' };
      let data = await fetchAllRowsByPeriode(supabase, periode);

      // Viewer: langsung pakai snapshot DB, skip semua auto-refresh/sync ke Maukirim
      if (!viewerCabang) {
        const autoRefresh = planNoncodAutoRefresh({
          periode,
          syncInfo,
          syncMeta,
          rowCount: data.length,
          forceSync,
          backgroundTriggerEnabled,
          pipelineState,
        });

        if (autoRefresh.action === 'inline') {
          try {
            syncInfo = await maybeSyncMaukirimPeriod(supabase, periode, { force: true });
            syncInfo.pipeline = pipelineState;
            syncInfo.triggerEnabled = backgroundTriggerEnabled;
            syncInfo.triggerMode = triggerConfig.mode;
            syncInfo.triggerTarget = triggerConfig.url;
            syncInfo.stale = false;
            syncInfo.refreshState = {
              action: 'inline',
              status: 'completed',
              reason: autoRefresh.reason,
            };
            data = await fetchAllRowsByPeriode(supabase, periode);
          } catch (syncErr) {
            console.error('[noncod sync]', syncErr.message);
            logError('noncod', syncErr.message, { method: 'GET', action: 'sync', periode, forceSync });
            syncInfo = {
              ...buildSyncInfo(periode, syncMeta),
              pipeline: pipelineState,
              triggerEnabled: backgroundTriggerEnabled,
              triggerMode: triggerConfig.mode,
              triggerTarget: triggerConfig.url,
              stale: syncInfo.stale,
              refreshState: {
                action: 'inline',
                status: 'failed',
                reason: autoRefresh.reason,
              },
              error: syncErr.message,
            };
          }
        } else if (autoRefresh.action === 'queue') {
          const queuedReason = 'snapshot_' + autoRefresh.reason;
          const queuedState = await markNoncodSyncQueued(supabase, {
            periodes: [periode],
            reason: queuedReason,
          });
          const triggerRequest = {
            reason: queuedReason,
            periodes: [periode],
            source: 'noncod-read',
            force: true,
          };
          const runTriggerTask = async () => {
            let triggerResult;
            try {
              triggerResult = await sendNoncodPipelineTrigger(triggerRequest);
            } catch (triggerError) {
              triggerResult = {
                skipped: false,
                ok: false,
                status: 0,
                target: triggerConfig.url,
                error: triggerError && triggerError.message ? triggerError.message : 'trigger_failed',
              };
            }

            if (triggerResult && triggerResult.ok) {
              return { ok: true };
            }

            const triggerFailure = triggerResult && !triggerResult.skipped
              ? (triggerResult.error || (triggerResult.status ? ('HTTP ' + triggerResult.status) : 'trigger_failed'))
              : 'trigger_unavailable';
            const failedState = await markNoncodSyncFailed(supabase, {
              reason: queuedReason,
              periodes: [periode],
              error: 'Trigger background gagal: ' + triggerFailure,
            });
            logError('noncod-sync', 'Trigger background gagal: ' + triggerFailure, {
              method: 'GET',
              action: 'queue_snapshot_refresh',
              periode,
              triggerTarget: triggerResult && triggerResult.target ? triggerResult.target : '',
            });
            return {
              ok: false,
              failedState,
              triggerFailure,
            };
          };

          if (typeof vercelWaitUntil === 'function') {
            scheduleNoncodBackgroundTask(runTriggerTask());
            syncInfo.pipeline = queuedState;
            syncInfo.refreshState = autoRefresh;
          } else {
            const triggerOutcome = await runTriggerTask();
            if (triggerOutcome && triggerOutcome.ok) {
              syncInfo.pipeline = queuedState;
              syncInfo.refreshState = autoRefresh;
            } else {
              syncInfo.pipeline = triggerOutcome && triggerOutcome.failedState ? triggerOutcome.failedState : queuedState;
              syncInfo.refreshState = {
                action: 'queue',
                status: 'failed',
                reason: autoRefresh.reason,
              };
              syncInfo.error = 'Trigger background gagal: ' + (triggerOutcome && triggerOutcome.triggerFailure ? triggerOutcome.triggerFailure : 'trigger_failed');
            }
          }
        } else if (autoRefresh.status !== 'idle') {
          syncInfo.refreshState = autoRefresh;
        }
      }

      const overrideMap = await readStatusOverridesByResi(supabase, (data || []).map((row) => row.nomor_resi));
      data = applyStatusOverrides(data, overrideMap);

      // Viewer: filter hanya data cabang sendiri (viewerCabang sudah di-resolve di atas)
      if (viewerCabang) {
        data = data.filter((row) => (row.cabang || '').trim() === viewerCabang.trim());
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
        // Workbook excludes raw BATAL rows; admin VOID override must stay excluded too.
        const statusRow = (row.status_terakhir || '').toUpperCase().trim();
        if (isExcludedNoncodStatus(statusRow)) continue;
        const method = normalizeMethod(row.metode_pembayaran);
        if (!method) continue;
        const c = (row.cabang || '').trim();
        if (!c || c === '-') continue;
        const ongkir = parseFloat(row.ongkir) || 0;
        const total = parseFloat(row.total_pengiriman) || 0;
        const tgl = getRekonDateKey(row);
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

        // Workbook report merekonsiliasi NONCOD dari Tanggal Buat, lalu dibandingkan ke transfer.tgl_inputan.
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
      if (!syncInfo.stats) {
        syncInfo.stats = {
          noncod: summary.noncod.totalResi,
          dfod: summary.dfod.totalResi,
        };
      }

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
        ...(viewerCabang ? { viewer: { cabang: viewerCabang } } : {}),
      });
    } catch (err) {
      console.error(err);
      logError('noncod', err.message, { method: 'GET' });
      return res.status(500).json({ error: 'Gagal memuat data noncod.' });
    }
  }

  // DELETE /api/noncod?periode=2026-04 — hapus semua data periode
  if (req.method === 'DELETE') {
    try {
      const supabase = getSupabase();
      const periode = normalizeText(req.query.periode, 20);
      if (!periode || !isValidPeriodeParam(periode)) {
        return res.status(400).json({ error: 'Parameter periode wajib (YYYY-MM) dengan bulan 01-12.' });
      }
      const { error } = await supabase.from('noncod').delete().eq('periode', periode);
      if (error) throw error;
      await publishNoncodMarkerSafe(supabase, {
        source: 'noncod_delete_periode',
        scopes: ['overview', 'noncod', 'dfod', 'audit', 'admin_monitor'],
        periodes: [periode],
      }, 'DELETE');
      return res.json({ success: true, deletedPeriode: periode });
    } catch (err) {
      console.error(err);
      logError('noncod', err.message, { method: 'DELETE' });
      return res.status(500).json({ error: 'Gagal menghapus data.' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed.' });
}

module.exports = handler;
module.exports.buildSyncInfo = buildSyncInfo;
module.exports.canAutoSyncMaukirim = canAutoSyncMaukirim;
module.exports.getAutoSyncPeriods = getAutoSyncPeriods;
module.exports.getRekonDateKey = getRekonDateKey;
module.exports.isAutoSyncablePeriode = isAutoSyncablePeriode;
module.exports.isSyncMetaStale = isSyncMetaStale;
module.exports.maybeSyncMaukirimPeriod = maybeSyncMaukirimPeriod;
module.exports.planPeriodeRowReconciliation = planPeriodeRowReconciliation;
module.exports.readSyncMeta = readSyncMeta;
module.exports.resolvePendingAllocations = resolvePendingAllocations;
module.exports.syncMaukirimPeriodes = syncMaukirimPeriodes;
module.exports.authorizeSyncRequest = authorizeSyncRequest;
module.exports.isValidPeriodeParam = isValidPeriodeParam;
module.exports.planNoncodAutoRefresh = planNoncodAutoRefresh;
module.exports.timingSafeSecretEqual = timingSafeSecretEqual;
