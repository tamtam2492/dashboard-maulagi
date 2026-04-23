const { applyStatusOverrides, readStatusOverridesByResi } = require('./_noncod-status-overrides');

const NONCOD_TRANSFER_ALLOCATION_KEY_PREFIX = 'noncod_transfer_allocation_';
const TEXT_MAX_LENGTH = 200;
const EXCLUDED_NONCOD_STATUSES = new Set(['BATAL', 'VOID']);

function normalizeText(value, maxLength = TEXT_MAX_LENGTH) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, maxLength);
}

function roundNominal(value) {
  const amount = Math.round(Number(value || 0));
  return Number.isFinite(amount) ? amount : 0;
}

function normalizeTransferAllocationTransferId(value) {
  return normalizeText(value, 64);
}

function normalizeTransferAllocationCabang(value) {
  return normalizeText(value, 100).toUpperCase();
}

function normalizeTransferAllocationResi(value) {
  return normalizeText(value, 100).toUpperCase();
}

function normalizeTransferAllocationDate(value) {
  const normalized = normalizeText(value, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(normalized) ? normalized : '';
}

function normalizeTransferAllocationTimestamp(value, fallback = '') {
  const normalized = normalizeText(value, 40);
  if (/^\d{4}-\d{2}-\d{2}T/.test(normalized)) return normalized;
  return fallback || '';
}

function isExcludedNoncodStatus(value) {
  return EXCLUDED_NONCOD_STATUSES.has(String(value || '').trim().toUpperCase());
}

function normalizeTransferAllocationItems(items) {
  return (Array.isArray(items) ? items : []).map((item) => {
    const nomorResi = normalizeTransferAllocationResi(item && item.nomor_resi);
    const tanggalBuat = normalizeTransferAllocationDate(item && item.tanggal_buat);
    const allocatedNominal = roundNominal(item && item.allocated_nominal);
    if (!nomorResi || !tanggalBuat || !(allocatedNominal > 0)) return null;
    return {
      nomor_resi: nomorResi,
      tanggal_buat: tanggalBuat,
      periode: tanggalBuat.slice(0, 7),
      allocated_nominal: allocatedNominal,
    };
  }).filter(Boolean);
}

function sumAllocationNominal(items) {
  return normalizeTransferAllocationItems(items)
    .reduce((sum, item) => sum + Number(item.allocated_nominal || 0), 0);
}

function buildTransferAllocationKey(transferId) {
  const normalizedTransferId = normalizeTransferAllocationTransferId(transferId);
  return normalizedTransferId ? NONCOD_TRANSFER_ALLOCATION_KEY_PREFIX + normalizedTransferId : '';
}

function createTransferAllocationRecord(input) {
  const nowIso = new Date().toISOString();
  const transferId = normalizeTransferAllocationTransferId(input && input.transfer_id);
  const cabang = normalizeTransferAllocationCabang(input && input.cabang);
  const transferDate = normalizeTransferAllocationDate(input && input.transfer_date);
  const transferNominal = roundNominal(input && input.transfer_nominal);
  const allocations = normalizeTransferAllocationItems(input && input.allocations);
  const allocatedTotal = sumAllocationNominal(allocations);
  const source = normalizeText(input && input.source, 80).toLowerCase();
  const proofKey = normalizeText(input && input.proof_key, 160);
  const createdAt = normalizeTransferAllocationTimestamp(input && input.created_at, nowIso);
  const updatedAt = normalizeTransferAllocationTimestamp(input && input.updated_at, nowIso);
  const inputUnallocated = roundNominal(input && input.unallocated_nominal);
  const unallocatedNominal = inputUnallocated > 0
    ? inputUnallocated
    : Math.max(transferNominal - allocatedTotal, 0);

  if (!transferId || !cabang || !transferDate || !(transferNominal > 0)) return null;

  return {
    transfer_id: transferId,
    cabang,
    transfer_date: transferDate,
    transfer_periode: transferDate.slice(0, 7),
    transfer_nominal: transferNominal,
    allocated_total: allocatedTotal,
    unallocated_nominal: unallocatedNominal,
    source,
    proof_key: proofKey,
    allocations,
    created_at: createdAt,
    updated_at: updatedAt,
  };
}

function parseTransferAllocationValue(value) {
  if (!value) return null;

  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return createTransferAllocationRecord(parsed);
  } catch {
    return null;
  }
}

async function fetchTransferAllocationSettingsByPrefix(supabase) {
  const allRows = [];
  let from = 0;

  while (true) {
    const { data, error } = await supabase
      .from('settings')
      .select('key, value')
      .like('key', NONCOD_TRANSFER_ALLOCATION_KEY_PREFIX + '%')
      .order('key', { ascending: true })
      .range(from, from + 999);

    if (error) throw error;
    if (!data || !data.length) break;

    allRows.push(...data);
    if (data.length < 1000) break;
    from += 1000;
  }

  return allRows;
}

async function readAllTransferAllocationRows(supabase) {
  const rows = await fetchTransferAllocationSettingsByPrefix(supabase);
  return rows
    .map((row) => parseTransferAllocationValue(row.value))
    .filter(Boolean)
    .sort((left, right) => String(left.created_at || '').localeCompare(String(right.created_at || '')) || left.transfer_id.localeCompare(right.transfer_id));
}

async function listTransferAllocationRows(supabase, options = {}) {
  const normalizedCabang = normalizeTransferAllocationCabang(options.cabang);
  const normalizedPeriode = normalizeText(options.periode, 7);
  const transferIds = new Set((Array.isArray(options.transferIds) ? options.transferIds : [])
    .map((item) => normalizeTransferAllocationTransferId(item))
    .filter(Boolean));
  const rows = await readAllTransferAllocationRows(supabase);

  return {
    rows: rows.filter((row) => {
      if (normalizedCabang && row.cabang !== normalizedCabang) return false;
      if (normalizedPeriode && row.transfer_periode !== normalizedPeriode) return false;
      if (transferIds.size && !transferIds.has(row.transfer_id)) return false;
      return true;
    }),
  };
}

async function readTransferAllocationRowsByTransferIds(supabase, transferIds) {
  const result = await listTransferAllocationRows(supabase, { transferIds });
  return result.rows;
}

async function upsertTransferAllocation(supabase, input) {
  const record = createTransferAllocationRecord(input);
  if (!record) {
    throw new Error('Data alokasi transfer NONCOD tidak valid.');
  }

  const key = buildTransferAllocationKey(record.transfer_id);
  const { error } = await supabase.from('settings').upsert({
    key,
    value: JSON.stringify(record),
  });
  if (error) throw error;
  return record;
}

async function deleteTransferAllocation(supabase, transferId) {
  const key = buildTransferAllocationKey(transferId);
  if (!key) {
    throw new Error('ID transfer alokasi tidak valid.');
  }

  const { error } = await supabase.from('settings').delete().eq('key', key);
  if (error) throw error;
}

async function deleteTransferAllocations(supabase, transferIds) {
  const keys = [...new Set((Array.isArray(transferIds) ? transferIds : [transferIds])
    .map((item) => buildTransferAllocationKey(item))
    .filter(Boolean))];
  if (!keys.length) return;

  for (let index = 0; index < keys.length; index += 200) {
    const batch = keys.slice(index, index + 200);
    const { error } = await supabase.from('settings').delete().in('key', batch);
    if (error) throw error;
  }
}

function buildNoncodRowStates(noncodRows) {
  return (Array.isArray(noncodRows) ? noncodRows : []).map((row, index) => {
    const metodePembayaran = String(row && row.metode_pembayaran || '').trim().toLowerCase();
    const nomorResi = normalizeTransferAllocationResi(row && row.nomor_resi);
    const tanggalBuat = normalizeTransferAllocationDate(row && row.tanggal_buat);
    const ongkir = roundNominal(row && row.ongkir);
    if (metodePembayaran !== 'noncod' || isExcludedNoncodStatus(row && row.status_terakhir)) return null;
    if (!nomorResi || !tanggalBuat || !(ongkir > 0)) return null;
    return {
      nomor_resi: nomorResi,
      tanggal_buat: tanggalBuat,
      periode: tanggalBuat.slice(0, 7),
      ongkir,
      remaining_nominal: ongkir,
      sequence: index,
    };
  }).filter(Boolean).sort((left, right) => left.tanggal_buat.localeCompare(right.tanggal_buat) || left.nomor_resi.localeCompare(right.nomor_resi) || left.sequence - right.sequence);
}

function applyAllocationItemsToRowStates(rowStateMap, allocationItems) {
  for (const item of normalizeTransferAllocationItems(allocationItems)) {
    const target = rowStateMap.get(item.nomor_resi);
    if (!target) continue;
    const appliedNominal = Math.min(Number(target.remaining_nominal || 0), Number(item.allocated_nominal || 0));
    target.remaining_nominal = Math.max(Number(target.remaining_nominal || 0) - appliedNominal, 0);
  }
}

function allocateNominalOnDate(rowStatesByDate, targetDate, nominal) {
  const normalizedDate = normalizeTransferAllocationDate(targetDate);
  let remainingNominal = roundNominal(nominal);
  const allocations = [];
  if (!normalizedDate || !(remainingNominal > 0)) {
    return { allocations, allocatedTotal: 0, unallocatedNominal: 0 };
  }

  const rowStates = rowStatesByDate.get(normalizedDate) || [];
  for (const rowState of rowStates) {
    if (!(remainingNominal > 0)) break;
    if (!(rowState.remaining_nominal > 0)) continue;

    const allocatedNominal = Math.min(Number(rowState.remaining_nominal || 0), remainingNominal);
    if (!(allocatedNominal > 0)) continue;

    allocations.push({
      nomor_resi: rowState.nomor_resi,
      tanggal_buat: rowState.tanggal_buat,
      periode: rowState.periode,
      allocated_nominal: allocatedNominal,
    });
    rowState.remaining_nominal = Math.max(Number(rowState.remaining_nominal || 0) - allocatedNominal, 0);
    remainingNominal -= allocatedNominal;
  }

  return {
    allocations,
    allocatedTotal: allocations.reduce((sum, item) => sum + Number(item.allocated_nominal || 0), 0),
    unallocatedNominal: Math.max(remainingNominal, 0),
  };
}

function buildTransferAllocationPlan(options = {}) {
  const rowStates = buildNoncodRowStates(options.noncodRows);
  const rowStateMap = new Map(rowStates.map((rowState) => [rowState.nomor_resi, rowState]));
  const rowStatesByDate = new Map();

  for (const rowState of rowStates) {
    const list = rowStatesByDate.get(rowState.tanggal_buat) || [];
    list.push(rowState);
    rowStatesByDate.set(rowState.tanggal_buat, list);
  }

  const existingAllocationRows = Array.isArray(options.existingAllocationRows) ? options.existingAllocationRows : [];
  const recordedTransferIds = new Set(existingAllocationRows.map((row) => normalizeTransferAllocationTransferId(row && row.transfer_id)).filter(Boolean));
  existingAllocationRows.forEach((row) => {
    applyAllocationItemsToRowStates(rowStateMap, row && row.allocations);
  });

  const legacyTransfers = (Array.isArray(options.existingTransfers) ? options.existingTransfers : [])
    .filter((row) => !recordedTransferIds.has(normalizeTransferAllocationTransferId(row && row.id)))
    .sort((left, right) => String(left && left.timestamp || '').localeCompare(String(right && right.timestamp || '')) || String(left && left.id || '').localeCompare(String(right && right.id || '')));

  legacyTransfers.forEach((row) => {
    allocateNominalOnDate(rowStatesByDate, row && row.tgl_inputan, row && row.nominal);
  });

  return (Array.isArray(options.plannedRows) ? options.plannedRows : []).map((row) => {
    const plan = allocateNominalOnDate(rowStatesByDate, row && row.tgl_inputan, row && row.nominal);
    return {
      tgl_inputan: normalizeTransferAllocationDate(row && row.tgl_inputan),
      nominal: roundNominal(row && row.nominal),
      allocations: plan.allocations,
      allocatedTotal: plan.allocatedTotal,
      unallocatedNominal: plan.unallocatedNominal,
    };
  });
}

function splitTransferAllocationRecord(record, newTransfers) {
  const sourceRecord = createTransferAllocationRecord(record);
  if (!sourceRecord) return [];

  const allocationItems = sourceRecord.allocations.map((item) => ({ ...item }));
  let allocationIndex = 0;
  let itemRemainingNominal = allocationItems[0] ? Number(allocationItems[0].allocated_nominal || 0) : 0;

  return (Array.isArray(newTransfers) ? newTransfers : []).map((transfer) => {
    const transferId = normalizeTransferAllocationTransferId(transfer && transfer.id);
    const transferDate = normalizeTransferAllocationDate(transfer && transfer.tgl_inputan);
    const transferNominal = roundNominal(transfer && transfer.nominal);
    const transferTimestamp = normalizeTransferAllocationTimestamp(transfer && transfer.timestamp, sourceRecord.updated_at);
    let remainingNominal = transferNominal;
    const allocations = [];

    while (remainingNominal > 0 && allocationIndex < allocationItems.length) {
      const currentItem = allocationItems[allocationIndex];
      const appliedNominal = Math.min(itemRemainingNominal, remainingNominal);
      if (appliedNominal > 0) {
        allocations.push({
          nomor_resi: currentItem.nomor_resi,
          tanggal_buat: currentItem.tanggal_buat,
          periode: currentItem.periode,
          allocated_nominal: appliedNominal,
        });
        remainingNominal -= appliedNominal;
        itemRemainingNominal -= appliedNominal;
      }

      if (!(itemRemainingNominal > 0)) {
        allocationIndex += 1;
        itemRemainingNominal = allocationItems[allocationIndex]
          ? Number(allocationItems[allocationIndex].allocated_nominal || 0)
          : 0;
      }
    }

    return createTransferAllocationRecord({
      transfer_id: transferId,
      cabang: transfer && transfer.nama_cabang || sourceRecord.cabang,
      transfer_date: transferDate,
      transfer_nominal: transferNominal,
      source: sourceRecord.source,
      proof_key: sourceRecord.proof_key,
      allocations,
      unallocated_nominal: Math.max(remainingNominal, 0),
      created_at: sourceRecord.created_at,
      updated_at: transferTimestamp,
    });
  }).filter(Boolean);
}

async function loadTransferAllocationContext(supabase, options = {}) {
  const cabang = normalizeTransferAllocationCabang(options.cabang);
  const targetDates = [...new Set((Array.isArray(options.targetDates) ? options.targetDates : [])
    .map((item) => normalizeTransferAllocationDate(item))
    .filter(Boolean))];
  const excludeTransferIds = new Set((Array.isArray(options.excludeTransferIds) ? options.excludeTransferIds : [])
    .map((item) => normalizeTransferAllocationTransferId(item))
    .filter(Boolean));

  if (!cabang || !targetDates.length) {
    return { effectiveRows: [], existingTransfers: [], existingAllocationRows: [] };
  }

  const periodes = [...new Set(targetDates.map((item) => item.slice(0, 7)).filter(Boolean))];
  const { data: noncodRows, error: noncodError } = await supabase
    .from('noncod')
    .select('tanggal_buat, ongkir, metode_pembayaran, nomor_resi, status_terakhir')
    .in('periode', periodes)
    .eq('cabang', cabang);
  if (noncodError) throw noncodError;

  const overrideMap = await readStatusOverridesByResi(supabase, (noncodRows || []).map((row) => row.nomor_resi));
  const effectiveRows = applyStatusOverrides(noncodRows, overrideMap);

  const { data: existingTransfers, error: transferError } = await supabase
    .from('transfers')
    .select('id, tgl_inputan, nominal, nama_cabang, timestamp')
    .eq('nama_cabang', cabang)
    .in('tgl_inputan', targetDates);
  if (transferError) throw transferError;

  const filteredTransfers = (existingTransfers || []).filter((row) => !excludeTransferIds.has(normalizeTransferAllocationTransferId(row && row.id)));
  const existingAllocationRows = await readTransferAllocationRowsByTransferIds(supabase, filteredTransfers.map((row) => row.id));

  return {
    effectiveRows,
    existingTransfers: filteredTransfers,
    existingAllocationRows,
  };
}

module.exports = {
  NONCOD_TRANSFER_ALLOCATION_KEY_PREFIX,
  applyAllocationItemsToRowStates,
  buildNoncodRowStates,
  buildTransferAllocationKey,
  buildTransferAllocationPlan,
  createTransferAllocationRecord,
  deleteTransferAllocation,
  deleteTransferAllocations,
  listTransferAllocationRows,
  loadTransferAllocationContext,
  normalizeTransferAllocationCabang,
  normalizeTransferAllocationDate,
  normalizeTransferAllocationItems,
  normalizeTransferAllocationResi,
  normalizeTransferAllocationTransferId,
  parseTransferAllocationValue,
  readAllTransferAllocationRows,
  readTransferAllocationRowsByTransferIds,
  splitTransferAllocationRecord,
  sumAllocationNominal,
  upsertTransferAllocation,
};