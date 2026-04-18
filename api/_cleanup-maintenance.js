const { OCR_JOB_PREFIX, parseOcrJobState } = require('./_ocr-job-pipeline');

const MONTHS_KEEP = 2;
const OCR_JOB_DAYS_KEEP = 7;
const VISITOR_DAYS_KEEP = 90;
const CLEANUP_LAST_RUN_KEY = 'cleanup_last_run';
const BUCKET = 'bukti-transfer';
const BATCH_SIZE = 100;

function padNumber(value) {
  return String(value).padStart(2, '0');
}

function createLogger(logger = console) {
  return {
    log: typeof logger.log === 'function' ? logger.log.bind(logger) : () => {},
    warn: typeof logger.warn === 'function' ? logger.warn.bind(logger) : () => {},
  };
}

function formatLocalDate(date) {
  return `${date.getFullYear()}-${padNumber(date.getMonth() + 1)}-${padNumber(date.getDate())}`;
}

function getCleanupRunDate(referenceDate = new Date(), timeZone = 'Asia/Makassar') {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });

  const parts = formatter.formatToParts(referenceDate);
  const year = parts.find((part) => part.type === 'year')?.value || '0000';
  const month = parts.find((part) => part.type === 'month')?.value || '01';
  const day = parts.find((part) => part.type === 'day')?.value || '01';
  return `${year}-${month}-${day}`;
}

function getTransferCutoffDate(referenceDate = new Date(), monthsKeep = MONTHS_KEEP) {
  const date = new Date(referenceDate);
  date.setMonth(date.getMonth() - monthsKeep);
  date.setDate(1);
  date.setHours(0, 0, 0, 0);
  return date.toISOString();
}

function getPeriodeCutoff(referenceDate = new Date(), monthsKeep = MONTHS_KEEP) {
  const date = new Date(referenceDate);
  date.setMonth(date.getMonth() - monthsKeep);
  return `${date.getFullYear()}-${padNumber(date.getMonth() + 1)}`;
}

function getVisitorCutoffDate(referenceDate = new Date(), daysKeep = VISITOR_DAYS_KEEP) {
  const date = new Date(referenceDate);
  date.setDate(date.getDate() - daysKeep);
  return formatLocalDate(date);
}

function getOcrJobCutoffDate(referenceDate = new Date(), daysKeep = OCR_JOB_DAYS_KEEP) {
  const date = new Date(referenceDate);
  date.setDate(date.getDate() - daysKeep);
  return date.toISOString();
}

function getOcrJobCleanupReference(state) {
  const jobState = parseOcrJobState(state);
  return jobState.finishedAt || jobState.updatedAt || jobState.createdAt || '';
}

function shouldDeleteOcrJobState(state, cutoffIso) {
  const cutoffMs = Date.parse(String(cutoffIso || ''));
  if (!Number.isFinite(cutoffMs)) return false;

  const referenceMs = Date.parse(getOcrJobCleanupReference(state));
  if (!Number.isFinite(referenceMs)) return false;

  return referenceMs < cutoffMs;
}

function isLocalStoragePath(path) {
  return !!path && !String(path).startsWith('http');
}

async function collectPagedRows(fetchPage, label) {
  let rows = [];
  let offset = 0;

  while (true) {
    const result = await fetchPage(offset, BATCH_SIZE);
    if (result.error) {
      throw new Error(`${label}: ${result.error.message}`);
    }

    const data = Array.isArray(result.data) ? result.data : [];
    if (data.length === 0) break;

    rows = rows.concat(data);
    if (data.length < BATCH_SIZE) break;
    offset += BATCH_SIZE;
  }

  return rows;
}

async function removeStorageFiles(supabase, filePaths, label, options = {}) {
  const { dryRun = false } = options;
  const logger = createLogger(options.logger);

  if (filePaths.length === 0) return;

  if (dryRun) {
    logger.log(`[DRY-RUN] Akan hapus file ${label}:`, filePaths.slice(0, 5), filePaths.length > 5 ? `...+${filePaths.length - 5} lainnya` : '');
    return;
  }

  for (let index = 0; index < filePaths.length; index += BATCH_SIZE) {
    const batch = filePaths.slice(index, index + BATCH_SIZE);
    const { error } = await supabase.storage.from(BUCKET).remove(batch);
    if (error) logger.warn(`  Storage ${label} batch ${index}-${index + batch.length} error:`, error.message);
    else logger.log(`  Storage ${label}: hapus ${batch.length} file (${index + 1}-${index + batch.length})`);
  }
}

async function deleteRowsByIds(supabase, table, column, values, label, options = {}) {
  const { dryRun = false } = options;
  const logger = createLogger(options.logger);

  if (values.length === 0) return;

  if (dryRun) {
    logger.log(`[DRY-RUN] Akan hapus ${values.length} rows ${label}`);
    return;
  }

  for (let index = 0; index < values.length; index += BATCH_SIZE) {
    const batch = values.slice(index, index + BATCH_SIZE);
    const { error } = await supabase.from(table).delete().in(column, batch);
    if (error) logger.warn(`  ${label} batch ${index}-${index + batch.length} error:`, error.message);
    else logger.log(`  ${label}: hapus ${batch.length} rows (${index + 1}-${index + batch.length})`);
  }
}

async function cleanupTransfers(supabase, options = {}) {
  const logger = createLogger(options.logger);
  const cutoff = options.cutoff || getTransferCutoffDate(options.referenceDate, options.monthsKeep);
  const dryRun = options.dryRun === true;

  const rows = await collectPagedRows((offset, limit) => supabase
    .from('transfers')
    .select('id, tgl_inputan, timestamp, bukti_url, nama_cabang')
    .lt('timestamp', cutoff)
    .order('timestamp', { ascending: true })
    .range(offset, offset + limit - 1), 'Fetch transfers');

  logger.log(`Ditemukan ${rows.length} rows transfer yang akan dihapus`);
  if (rows.length === 0) {
    logger.log('Tidak ada data transfer untuk dihapus.');
    return { rowCount: 0, fileCount: 0, cutoff };
  }

  const filePaths = rows.map((row) => row.bukti_url).filter(isLocalStoragePath);
  logger.log(`File foto transfer: ${filePaths.length}`);
  await removeStorageFiles(supabase, filePaths, 'transfer', { dryRun, logger });

  const ids = rows.map((row) => row.id);
  if (dryRun) {
    logger.log('Contoh transfer:', rows.slice(0, 3).map((row) => `${row.tgl_inputan} ${row.nama_cabang}`));
  }
  await deleteRowsByIds(supabase, 'transfers', 'id', ids, 'DB transfer', { dryRun, logger });

  return { rowCount: ids.length, fileCount: filePaths.length, cutoff };
}

async function cleanupNoncod(supabase, options = {}) {
  const logger = createLogger(options.logger);
  const cutoffPeriode = options.cutoffPeriode || getPeriodeCutoff(options.referenceDate, options.monthsKeep);
  const dryRun = options.dryRun === true;

  const rows = await collectPagedRows((offset, limit) => supabase
    .from('noncod')
    .select('periode, nomor_resi')
    .lt('periode', cutoffPeriode)
    .order('periode', { ascending: true })
    .range(offset, offset + limit - 1), 'Fetch NONCOD');

  logger.log(`Ditemukan ${rows.length} rows NONCOD yang akan dihapus`);
  if (rows.length === 0) {
    logger.log('Tidak ada data NONCOD untuk dihapus.');
    return { rowCount: 0, cutoffPeriode };
  }

  if (dryRun) {
    logger.log('Contoh NONCOD:', rows.slice(0, 3).map((row) => `${row.periode} ${row.nomor_resi || ''}`.trim()));
  } else {
    const { error } = await supabase.from('noncod').delete().lt('periode', cutoffPeriode);
    if (error) throw error;
    logger.log(`  DB NONCOD: hapus ${rows.length} rows`);
  }

  return { rowCount: rows.length, cutoffPeriode };
}

async function cleanupVisitors(supabase, options = {}) {
  const logger = createLogger(options.logger);
  const cutoffDate = options.cutoffDate || getVisitorCutoffDate(options.referenceDate, options.daysKeep);
  const dryRun = options.dryRun === true;

  const rows = await collectPagedRows((offset, limit) => supabase
    .from('visitors')
    .select('tgl')
    .lt('tgl', cutoffDate)
    .order('tgl', { ascending: true })
    .range(offset, offset + limit - 1), 'Fetch visitors');

  logger.log(`Ditemukan ${rows.length} rows visitor yang akan dihapus`);
  if (rows.length === 0) {
    logger.log('Tidak ada data visitor untuk dihapus.');
    return { rowCount: 0, cutoffDate };
  }

  if (dryRun) {
    logger.log('Contoh visitor:', rows.slice(0, 3).map((row) => row.tgl));
  } else {
    const { error } = await supabase.from('visitors').delete().lt('tgl', cutoffDate);
    if (error) throw error;
    logger.log(`  DB visitor: hapus ${rows.length} rows`);
  }

  return { rowCount: rows.length, cutoffDate };
}

async function cleanupOcrJobs(supabase, options = {}) {
  const logger = createLogger(options.logger);
  const cutoff = options.cutoff || getOcrJobCutoffDate(options.referenceDate, options.ocrDaysKeep);
  const dryRun = options.dryRun === true;

  const rows = await collectPagedRows((offset, limit) => supabase
    .from('settings')
    .select('key, value')
    .like('key', `${OCR_JOB_PREFIX}%`)
    .order('key', { ascending: true })
    .range(offset, offset + limit - 1), 'Fetch OCR jobs');

  const staleRows = rows
    .map((row) => ({
      key: row.key,
      state: parseOcrJobState(row.value),
    }))
    .filter((row) => shouldDeleteOcrJobState(row.state, cutoff));

  logger.log(`Ditemukan ${staleRows.length} state OCR lama yang akan dibersihkan`);
  if (staleRows.length === 0) {
    logger.log('Tidak ada state OCR lama untuk dihapus.');
    return { rowCount: 0, fileCount: 0, cutoff };
  }

  const filePaths = staleRows.map((row) => row.state.storagePath).filter(isLocalStoragePath);
  logger.log(`File OCR sementara: ${filePaths.length}`);
  await removeStorageFiles(supabase, filePaths, 'ocr-job', { dryRun, logger });

  const keys = staleRows.map((row) => row.key);
  if (dryRun) {
    logger.log('Contoh OCR job:', staleRows.slice(0, 3).map((row) => ({
      key: row.key,
      status: row.state.status,
      ref: getOcrJobCleanupReference(row.state),
    })));
  }
  await deleteRowsByIds(supabase, 'settings', 'key', keys, 'DB OCR job', { dryRun, logger });

  return { rowCount: keys.length, fileCount: filePaths.length, cutoff };
}

async function runMaintenanceCleanup(supabase, options = {}) {
  const referenceDate = options.referenceDate || new Date();
  return {
    transfer: await cleanupTransfers(supabase, { ...options, referenceDate }),
    noncod: await cleanupNoncod(supabase, { ...options, referenceDate }),
    visitors: await cleanupVisitors(supabase, { ...options, referenceDate }),
    ocrJobs: await cleanupOcrJobs(supabase, { ...options, referenceDate }),
  };
}

module.exports = {
  BATCH_SIZE,
  BUCKET,
  CLEANUP_LAST_RUN_KEY,
  MONTHS_KEEP,
  OCR_JOB_DAYS_KEEP,
  VISITOR_DAYS_KEEP,
  cleanupNoncod,
  cleanupOcrJobs,
  cleanupTransfers,
  cleanupVisitors,
  getCleanupRunDate,
  getOcrJobCleanupReference,
  getOcrJobCutoffDate,
  getPeriodeCutoff,
  getTransferCutoffDate,
  getVisitorCutoffDate,
  runMaintenanceCleanup,
  shouldDeleteOcrJobState,
};