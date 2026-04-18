/**
 * cleanup.js
 * Hapus data transfers + foto bukti lebih dari 2 bulan
 * Jalankan: node -r dotenv/config scripts/local/cleanup.js
 * Atau dry-run: node -r dotenv/config scripts/local/cleanup.js --dry-run
 */
const { createClient } = require('@supabase/supabase-js');
const { OCR_JOB_PREFIX, parseOcrJobState } = require('../../api/_ocr-job-pipeline');

const DRY_RUN = process.argv.includes('--dry-run');
const MONTHS_KEEP = 2;
const OCR_JOB_DAYS_KEEP = 7;
const BUCKET = 'bukti-transfer';
const BATCH_SIZE = 100;

function getSupabase() {
  const url  = process.env.SUPABASE_URL;
  const key  = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) { console.error('Set SUPABASE_URL dan SUPABASE_SERVICE_ROLE_KEY'); process.exit(1); }
  return createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

function getTransferCutoffDate(referenceDate = new Date(), monthsKeep = MONTHS_KEEP) {
  const d = new Date(referenceDate);
  d.setMonth(d.getMonth() - monthsKeep);
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

function getOcrJobCutoffDate(referenceDate = new Date(), daysKeep = OCR_JOB_DAYS_KEEP) {
  const d = new Date(referenceDate);
  d.setDate(d.getDate() - daysKeep);
  return d.toISOString();
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

async function removeStorageFiles(supabase, filePaths, label) {
  if (filePaths.length === 0) return;

  if (DRY_RUN) {
    console.log(`[DRY-RUN] Akan hapus file ${label}:`, filePaths.slice(0, 5), filePaths.length > 5 ? `...+${filePaths.length - 5} lainnya` : '');
    return;
  }

  for (let i = 0; i < filePaths.length; i += BATCH_SIZE) {
    const batch = filePaths.slice(i, i + BATCH_SIZE);
    const { error } = await supabase.storage.from(BUCKET).remove(batch);
    if (error) console.warn(`  Storage ${label} batch ${i}-${i + batch.length} error:`, error.message);
    else console.log(`  Storage ${label}: hapus ${batch.length} file (${i + 1}-${i + batch.length})`);
  }
}

async function deleteRowsByIds(supabase, table, column, values, label) {
  if (values.length === 0) return;

  if (DRY_RUN) {
    console.log(`[DRY-RUN] Akan hapus ${values.length} rows ${label}`);
    return;
  }

  for (let i = 0; i < values.length; i += BATCH_SIZE) {
    const batch = values.slice(i, i + BATCH_SIZE);
    const { error } = await supabase.from(table).delete().in(column, batch);
    if (error) console.warn(`  ${label} batch ${i}-${i + batch.length} error:`, error.message);
    else console.log(`  ${label}: hapus ${batch.length} rows (${i + 1}-${i + batch.length})`);
  }
}

async function cleanupTransfers(supabase, cutoff) {
  const allRows = await collectPagedRows((offset, limit) => supabase
    .from('transfers')
    .select('id, tgl_inputan, timestamp, bukti_url, nama_cabang')
    .lt('timestamp', cutoff)
    .order('timestamp', { ascending: true })
    .range(offset, offset + limit - 1), 'Fetch transfers');

  console.log(`Ditemukan ${allRows.length} rows transfer yang akan dihapus`);
  if (allRows.length === 0) {
    console.log('Tidak ada data transfer untuk dihapus.');
    return { rowCount: 0, fileCount: 0 };
  }

  const filePaths = allRows.map((row) => row.bukti_url).filter(isLocalStoragePath);
  console.log(`File foto transfer: ${filePaths.length}`);

  await removeStorageFiles(supabase, filePaths, 'transfer');

  const ids = allRows.map((row) => row.id);
  if (DRY_RUN) {
    console.log('Contoh transfer:', allRows.slice(0, 3).map((row) => `${row.tgl_inputan} ${row.nama_cabang}`));
  }
  await deleteRowsByIds(supabase, 'transfers', 'id', ids, 'DB transfer');

  return { rowCount: ids.length, fileCount: filePaths.length };
}

async function cleanupOcrJobs(supabase, cutoff) {
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

  console.log(`Ditemukan ${staleRows.length} state OCR lama yang akan dibersihkan`);
  if (staleRows.length === 0) {
    console.log('Tidak ada state OCR lama untuk dihapus.');
    return { rowCount: 0, fileCount: 0 };
  }

  const filePaths = staleRows
    .map((row) => row.state.storagePath)
    .filter(isLocalStoragePath);

  console.log(`File OCR sementara: ${filePaths.length}`);
  await removeStorageFiles(supabase, filePaths, 'ocr-job');

  const keys = staleRows.map((row) => row.key);
  if (DRY_RUN) {
    console.log('Contoh OCR job:', staleRows.slice(0, 3).map((row) => ({
      key: row.key,
      status: row.state.status,
      ref: getOcrJobCleanupReference(row.state),
    })));
  }
  await deleteRowsByIds(supabase, 'settings', 'key', keys, 'DB OCR job');

  return { rowCount: keys.length, fileCount: filePaths.length };
}

async function run() {
  const supabase = getSupabase();
  const transferCutoff = getTransferCutoffDate();
  const ocrJobCutoff = getOcrJobCutoffDate();

  console.log(`Mode    : ${DRY_RUN ? 'DRY-RUN (tidak menghapus)' : 'LIVE (akan menghapus permanen)'}`);
  console.log(`Cutoff transfer : data sebelum ${transferCutoff.slice(0, 10)}`);
  console.log(`Cutoff OCR job  : state sebelum ${ocrJobCutoff.slice(0, 10)}\n`);

  const transferResult = await cleanupTransfers(supabase, transferCutoff);
  console.log('');
  const ocrJobResult = await cleanupOcrJobs(supabase, ocrJobCutoff);

  if (!DRY_RUN) {
    console.log(`\nSelesai. Transfer dihapus: ${transferResult.rowCount} rows + ${transferResult.fileCount} foto.`);
    console.log(`Selesai. OCR job dibersihkan: ${ocrJobResult.rowCount} state + ${ocrJobResult.fileCount} file.`);
  }

  if (DRY_RUN) {
    console.log('\nJalankan tanpa --dry-run untuk menghapus permanen:');
    console.log('  node -r dotenv/config scripts/local/cleanup.js');
  }
}

if (require.main === module) {
  run().catch((err) => { console.error(err); process.exit(1); });
}

module.exports = {
  MONTHS_KEEP,
  OCR_JOB_DAYS_KEEP,
  getTransferCutoffDate,
  getOcrJobCleanupReference,
  getOcrJobCutoffDate,
  shouldDeleteOcrJobState,
};
