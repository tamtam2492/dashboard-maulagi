/**
 * cleanup.js
 * Hapus data transfer/noncod/visitor lama + state OCR sementara
 * Jalankan: node -r dotenv/config scripts/local/cleanup.js
 * Atau dry-run: node -r dotenv/config scripts/local/cleanup.js --dry-run
 */
const { getSupabase } = require('../../api/_supabase');
const {
  MONTHS_KEEP,
  OCR_JOB_DAYS_KEEP,
  VISITOR_DAYS_KEEP,
  getOcrJobCleanupReference,
  getOcrJobCutoffDate,
  getPeriodeCutoff,
  getTransferCutoffDate,
  getVisitorCutoffDate,
  runMaintenanceCleanup,
  shouldDeleteOcrJobState,
} = require('../../api/_cleanup-maintenance');

const DRY_RUN = process.argv.includes('--dry-run');

async function run() {
  const supabase = getSupabase();
  const transferCutoff = getTransferCutoffDate();
  const noncodCutoff = getPeriodeCutoff();
  const visitorCutoff = getVisitorCutoffDate();
  const ocrJobCutoff = getOcrJobCutoffDate();

  console.log(`Mode    : ${DRY_RUN ? 'DRY-RUN (tidak menghapus)' : 'LIVE (akan menghapus permanen)'}`);
  console.log(`Cutoff transfer : timestamp sebelum awal ${noncodCutoff}`);
  console.log(`Cutoff NONCOD   : periode sebelum ${noncodCutoff}`);
  console.log(`Cutoff visitor  : tanggal sebelum ${visitorCutoff}`);
  console.log(`Cutoff OCR job  : state sebelum ${ocrJobCutoff.slice(0, 10)}\n`);

  const summary = await runMaintenanceCleanup(supabase, {
    dryRun: DRY_RUN,
    logger: console,
    cutoff: transferCutoff,
    cutoffPeriode: noncodCutoff,
    cutoffDate: visitorCutoff,
    ocrCutoff: ocrJobCutoff,
  });

  if (!DRY_RUN) {
    console.log(`\nSelesai. Transfer dihapus: ${summary.transfer.rowCount} rows + ${summary.transfer.fileCount} foto.`);
    console.log(`Selesai. NONCOD dihapus: ${summary.noncod.rowCount} rows.`);
    console.log(`Selesai. Visitor dihapus: ${summary.visitors.rowCount} rows.`);
    console.log(`Selesai. OCR job dibersihkan: ${summary.ocrJobs.rowCount} state + ${summary.ocrJobs.fileCount} file.`);
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
  VISITOR_DAYS_KEEP,
  getTransferCutoffDate,
  getPeriodeCutoff,
  getVisitorCutoffDate,
  getOcrJobCleanupReference,
  getOcrJobCutoffDate,
  shouldDeleteOcrJobState,
};
