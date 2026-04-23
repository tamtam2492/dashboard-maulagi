/**
 * backfill-transfer-allocations.js
 * Bangun ulang registry settings noncod_transfer_allocation_<transferId>
 * dari histori transfer lama secara berurutan per cabang.
 *
 * Dry-run:
 *   node -r dotenv/config scripts/local/backfill-transfer-allocations.js
 * Live:
 *   node -r dotenv/config scripts/local/backfill-transfer-allocations.js --live
 * Filter:
 *   node -r dotenv/config scripts/local/backfill-transfer-allocations.js --periode=2026-04 --cabang="CABANG KENDARI 01"
 */
const { getSupabase } = require('../../api/_supabase');
const {
  buildTransferAllocationKey,
  buildTransferAllocationPlan,
  createTransferAllocationRecord,
  readAllTransferAllocationRows,
} = require('../../api/_noncod-transfer-allocations');
const {
  normalizeProofTransferIds,
  parseProofSignatureValue,
} = require('../../api/_proof-signature');

const PAGE_SIZE = 1000;
const WRITE_BATCH_SIZE = 200;
const DRY_RUN = !process.argv.includes('--live');

function normalizeText(value, maxLength = 200) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, maxLength);
}

function normalizeCabang(value) {
  return normalizeText(value, 120).toUpperCase();
}

function normalizePeriode(value) {
  const normalized = normalizeText(value, 7);
  return /^\d{4}-\d{2}$/.test(normalized) ? normalized : '';
}

function roundNominal(value) {
  const normalized = Math.round(Number(value || 0));
  return Number.isFinite(normalized) ? normalized : 0;
}

function parseArgs(argv = process.argv.slice(2)) {
  const periodeArg = argv.find((item) => item.startsWith('--periode='));
  const cabangArg = argv.find((item) => item.startsWith('--cabang='));
  const limitArg = argv.find((item) => item.startsWith('--limit='));

  const periodes = String(periodeArg || '')
    .replace(/^--periode=/, '')
    .split(',')
    .map((item) => normalizePeriode(item))
    .filter(Boolean);
  const cabang = normalizeCabang(String(cabangArg || '').replace(/^--cabang=/, ''));
  const limit = Math.max(0, Number(String(limitArg || '').replace(/^--limit=/, '')) || 0);

  return {
    dryRun: DRY_RUN,
    periodes,
    cabang,
    limit,
  };
}

function sortTransfersChronologically(transfers) {
  return (Array.isArray(transfers) ? transfers : [])
    .slice()
    .sort((left, right) => (
      String(left && left.timestamp || '').localeCompare(String(right && right.timestamp || ''))
      || String(left && left.id || '').localeCompare(String(right && right.id || ''))
    ));
}

function groupTransfersByCabang(transfers) {
  const grouped = new Map();

  for (const transfer of sortTransfersChronologically(transfers)) {
    const cabang = normalizeCabang(transfer && transfer.nama_cabang);
    if (!cabang) continue;
    const bucket = grouped.get(cabang) || [];
    bucket.push(transfer);
    grouped.set(cabang, bucket);
  }

  return grouped;
}

function buildExistingAllocationMap(rows) {
  const map = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const transferId = normalizeText(row && row.transfer_id, 120);
    if (!transferId) continue;
    map.set(transferId, row);
  }
  return map;
}

function buildTransferAllocationBackfillRecords(options = {}) {
  const nowIso = normalizeText(options.nowIso, 40) || new Date().toISOString();
  const transfers = sortTransfersChronologically(options.transfers);
  const existingAllocationMap = buildExistingAllocationMap(options.existingAllocationRows);
  const proofKeyByTransferId = options.proofKeyByTransferId instanceof Map
    ? options.proofKeyByTransferId
    : new Map();

  const plans = buildTransferAllocationPlan({
    noncodRows: Array.isArray(options.noncodRows) ? options.noncodRows : [],
    existingTransfers: [],
    existingAllocationRows: [],
    plannedRows: transfers.map((transfer) => ({
      tgl_inputan: String(transfer && transfer.tgl_inputan || '').trim(),
      nominal: roundNominal(transfer && transfer.nominal),
    })),
  });

  return transfers.map((transfer, index) => {
    const transferId = normalizeText(transfer && transfer.id, 120);
    const existing = existingAllocationMap.get(transferId) || null;
    const plan = plans[index] || {
      allocations: [],
      unallocatedNominal: roundNominal(transfer && transfer.nominal),
    };

    return createTransferAllocationRecord({
      transfer_id: transferId,
      cabang: transfer && transfer.nama_cabang,
      transfer_date: transfer && transfer.tgl_inputan,
      transfer_nominal: transfer && transfer.nominal,
      source: existing && existing.source ? existing.source : 'backfill_legacy',
      proof_key: existing && existing.proof_key ? existing.proof_key : (proofKeyByTransferId.get(transferId) || ''),
      allocations: plan.allocations,
      unallocated_nominal: plan.unallocatedNominal,
      created_at: existing && existing.created_at ? existing.created_at : transfer && transfer.timestamp,
      updated_at: nowIso,
    });
  }).filter(Boolean);
}

function summarizeBackfillRecords(records) {
  const summary = {
    total: 0,
    allocated: 0,
    unallocated: 0,
    partial: 0,
    totalNominal: 0,
    totalAllocatedNominal: 0,
    totalUnallocatedNominal: 0,
    issues: [],
  };

  for (const record of Array.isArray(records) ? records : []) {
    const transferNominal = roundNominal(record && record.transfer_nominal);
    const allocatedTotal = roundNominal(record && record.allocated_total);
    const unallocatedNominal = roundNominal(record && record.unallocated_nominal);
    summary.total += 1;
    summary.totalNominal += transferNominal;
    summary.totalAllocatedNominal += allocatedTotal;
    summary.totalUnallocatedNominal += unallocatedNominal;

    if (allocatedTotal > 0 && unallocatedNominal <= 0) {
      summary.allocated += 1;
      continue;
    }
    if (allocatedTotal > 0 && unallocatedNominal > 0) {
      summary.partial += 1;
    } else {
      summary.unallocated += 1;
    }

    summary.issues.push({
      transfer_id: record.transfer_id,
      cabang: record.cabang,
      transfer_date: record.transfer_date,
      transfer_nominal: transferNominal,
      allocated_total: allocatedTotal,
      unallocated_nominal: unallocatedNominal,
    });
  }

  return summary;
}

async function fetchPagedRows(buildQuery) {
  const rows = [];
  let from = 0;

  while (true) {
    const query = buildQuery(from, from + PAGE_SIZE - 1);
    const { data, error } = await query;
    if (error) throw error;
    if (!data || !data.length) break;
    rows.push(...data);
    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }

  return rows;
}

async function fetchTransfers(supabase, filters = {}) {
  const periodes = Array.isArray(filters.periodes) ? filters.periodes.filter(Boolean) : [];
  const cabang = normalizeCabang(filters.cabang);

  const rows = await fetchPagedRows((from, to) => {
    let query = supabase
      .from('transfers')
      .select('id, timestamp, tgl_inputan, periode, nama_cabang, nominal, ket, nama_bank, bukti_url')
      .order('timestamp', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to);

    if (periodes.length === 1) query = query.eq('periode', periodes[0]);
    if (periodes.length > 1) query = query.in('periode', periodes);
    if (cabang) query = query.eq('nama_cabang', cabang);
    return query;
  });

  return sortTransfersChronologically(rows);
}

async function fetchNoncodRowsForCabang(supabase, cabang, periodes) {
  if (!cabang || !Array.isArray(periodes) || !periodes.length) return [];

  return fetchPagedRows((from, to) => (
    supabase
      .from('noncod')
      .select('tanggal_buat, ongkir, metode_pembayaran, nomor_resi, status_terakhir')
      .eq('cabang', cabang)
      .in('periode', periodes)
      .range(from, to)
  ));
}

async function fetchProofKeyByTransferId(supabase, targetTransferIds) {
  const targetIds = new Set((Array.isArray(targetTransferIds) ? targetTransferIds : [])
    .map((item) => normalizeText(item, 120))
    .filter(Boolean));
  const proofKeyByTransferId = new Map();
  if (!targetIds.size) return proofKeyByTransferId;

  const rows = await fetchPagedRows((from, to) => (
    supabase
      .from('settings')
      .select('key, value')
      .like('key', 'proof_signature_%')
      .order('key', { ascending: true })
      .range(from, to)
  ));

  for (const row of rows) {
    const parsed = parseProofSignatureValue(row && row.value);
    if (!parsed) continue;
    for (const transferId of normalizeProofTransferIds(parsed)) {
      if (!targetIds.has(transferId) || proofKeyByTransferId.has(transferId)) continue;
      proofKeyByTransferId.set(transferId, normalizeText(row && row.key, 200));
    }
  }

  return proofKeyByTransferId;
}

async function writeAllocationRecords(supabase, records) {
  const normalizedRecords = (Array.isArray(records) ? records : []).filter(Boolean);
  for (let index = 0; index < normalizedRecords.length; index += WRITE_BATCH_SIZE) {
    const batch = normalizedRecords.slice(index, index + WRITE_BATCH_SIZE);
    const payload = batch.map((record) => ({
      key: buildTransferAllocationKey(record.transfer_id),
      value: JSON.stringify(record),
    }));
    const { error } = await supabase.from('settings').upsert(payload);
    if (error) throw error;
  }
}

async function run() {
  const options = parseArgs();
  const supabase = getSupabase();
  const nowIso = new Date().toISOString();

  console.log(`Mode   : ${options.dryRun ? 'DRY-RUN (tidak menulis settings)' : 'LIVE (menulis settings)'}`);
  console.log(`Periode: ${options.periodes.length ? options.periodes.join(', ') : 'SEMUA'}`);
  console.log(`Cabang : ${options.cabang || 'SEMUA'}${options.limit > 0 ? `\nLimit  : ${options.limit} transfer pertama` : ''}`);

  const transfers = await fetchTransfers(supabase, options);
  const limitedTransfers = options.limit > 0 ? transfers.slice(0, options.limit) : transfers;
  if (!limitedTransfers.length) {
    console.log('\nTidak ada transfer yang cocok dengan filter.');
    return;
  }

  const existingAllocationRows = await readAllTransferAllocationRows(supabase);
  const proofKeyByTransferId = await fetchProofKeyByTransferId(
    supabase,
    limitedTransfers.map((transfer) => transfer.id),
  );

  const groupedTransfers = groupTransfersByCabang(limitedTransfers);
  const allRecords = [];
  const cabangSummaries = [];

  for (const [cabang, cabangTransfers] of groupedTransfers.entries()) {
    const periodes = [...new Set(cabangTransfers.map((transfer) => normalizePeriode(transfer.periode)).filter(Boolean))];
    const noncodRows = await fetchNoncodRowsForCabang(supabase, cabang, periodes);
    const cabangAllocationRows = existingAllocationRows.filter((row) => row.cabang === cabang);
    const records = buildTransferAllocationBackfillRecords({
      transfers: cabangTransfers,
      noncodRows,
      existingAllocationRows: cabangAllocationRows,
      proofKeyByTransferId,
      nowIso,
    });
    const summary = summarizeBackfillRecords(records);

    cabangSummaries.push({
      cabang,
      transferCount: cabangTransfers.length,
      allocated: summary.allocated,
      partial: summary.partial,
      unallocated: summary.unallocated,
      unallocatedNominal: summary.totalUnallocatedNominal,
    });
    allRecords.push(...records);
  }

  const overall = summarizeBackfillRecords(allRecords);
  console.log(`\nTransfer diproses : ${overall.total}`);
  console.log(`Allocated penuh   : ${overall.allocated}`);
  console.log(`Partial           : ${overall.partial}`);
  console.log(`Tanpa alokasi     : ${overall.unallocated}`);
  console.log(`Nominal total     : Rp ${overall.totalNominal.toLocaleString('id-ID')}`);
  console.log(`Allocated total   : Rp ${overall.totalAllocatedNominal.toLocaleString('id-ID')}`);
  console.log(`Sisa unallocated  : Rp ${overall.totalUnallocatedNominal.toLocaleString('id-ID')}`);

  const problematicCabang = cabangSummaries
    .filter((item) => item.partial > 0 || item.unallocated > 0)
    .sort((left, right) => right.unallocatedNominal - left.unallocatedNominal || right.unallocated - left.unallocated);
  if (problematicCabang.length) {
    console.log('\nCabang dengan isu alokasi:');
    problematicCabang.slice(0, 20).forEach((item) => {
      console.log(`- ${item.cabang}: partial ${item.partial}, kosong ${item.unallocated}, sisa Rp ${item.unallocatedNominal.toLocaleString('id-ID')}`);
    });
  }

  if (overall.issues.length) {
    console.log('\nContoh transfer bermasalah:');
    overall.issues.slice(0, 20).forEach((issue) => {
      console.log(`- ${issue.transfer_id} | ${issue.cabang} | ${issue.transfer_date} | nominal Rp ${issue.transfer_nominal.toLocaleString('id-ID')} | allocated Rp ${issue.allocated_total.toLocaleString('id-ID')} | sisa Rp ${issue.unallocated_nominal.toLocaleString('id-ID')}`);
    });
  }

  if (options.dryRun) {
    console.log('\nDry-run selesai. Jalankan dengan --live untuk menulis registry ke settings.');
    return;
  }

  await writeAllocationRecords(supabase, allRecords);
  console.log(`\nLive selesai. Registry ditulis/diupdate: ${allRecords.length} transfer.`);
}

if (require.main === module) {
  run().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = {
  buildExistingAllocationMap,
  buildTransferAllocationBackfillRecords,
  groupTransfersByCabang,
  parseArgs,
  sortTransfersChronologically,
  summarizeBackfillRecords,
};