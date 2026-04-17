const NONCOD_PENDING_ALLOCATION_KEY_PREFIX = 'noncod_pending_allocation_';
const PENDING_TEXT_MAX_LENGTH = 200;
const PENDING_PROOF_PATH_MAX_LENGTH = 255;

function normalizePendingTransferId(value) {
  return String(value || '').trim().slice(0, 64);
}

function normalizePendingCabang(value) {
  return String(value || '').trim().toUpperCase().slice(0, 100);
}

function normalizePendingDate(value) {
  const normalized = String(value || '').trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(normalized) ? normalized : '';
}

function normalizePendingAmount(value) {
  const amount = Math.round(Number(value || 0));
  return Number.isFinite(amount) && amount > 0 ? amount : 0;
}

function normalizePendingText(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, PENDING_TEXT_MAX_LENGTH);
}

function normalizePendingBank(value) {
  return String(value || '').trim().toUpperCase().slice(0, 30);
}

function normalizePendingProofPath(value) {
  return String(value || '').trim().slice(0, PENDING_PROOF_PATH_MAX_LENGTH);
}

function normalizePendingTimestamp(value, fallback = '') {
  const normalized = String(value || '').trim();
  if (/^\d{4}-\d{2}-\d{2}T/.test(normalized)) return normalized;
  return fallback || '';
}

function buildPendingAllocationKey(transferId) {
  const normalizedTransferId = normalizePendingTransferId(transferId);
  return normalizedTransferId ? NONCOD_PENDING_ALLOCATION_KEY_PREFIX + normalizedTransferId : '';
}

function createPendingAllocationRecord(input) {
  const rootTransferId = normalizePendingTransferId(input && input.root_transfer_id);
  const cabang = normalizePendingCabang(input && input.cabang);
  const afterDate = normalizePendingDate(input && input.after_date);
  const nominal = normalizePendingAmount(input && input.nominal);
  const reason = normalizePendingText(input && input.reason);
  const ket = normalizePendingText(input && input.ket);
  const transferBank = normalizePendingBank(input && input.transfer_bank);
  const buktiUrl = normalizePendingProofPath(input && input.bukti_url);
  const nowIso = new Date().toISOString();
  const timestamp = normalizePendingTimestamp(input && input.timestamp, nowIso);
  const createdAt = normalizePendingTimestamp(input && input.created_at, nowIso);
  const updatedAt = normalizePendingTimestamp(input && input.updated_at, nowIso);

  if (!rootTransferId || !cabang || !afterDate || !buktiUrl) return null;
  if (!(nominal > 0)) return null;

  return {
    root_transfer_id: rootTransferId,
    cabang,
    after_date: afterDate,
    after_periode: afterDate.slice(0, 7),
    nominal,
    reason,
    ket,
    transfer_bank: transferBank,
    bukti_url: buktiUrl,
    timestamp,
    created_at: createdAt,
    updated_at: updatedAt,
  };
}

function parsePendingAllocationValue(value) {
  if (!value) return null;

  try {
    const parsed = JSON.parse(value);
    return createPendingAllocationRecord(parsed);
  } catch {
    return null;
  }
}

async function fetchPendingAllocationSettingsByPrefix(supabase) {
  const allRows = [];
  let from = 0;

  while (true) {
    const { data, error } = await supabase
      .from('settings')
      .select('key, value')
      .like('key', NONCOD_PENDING_ALLOCATION_KEY_PREFIX + '%')
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

async function readAllPendingAllocationRows(supabase) {
  const rows = await fetchPendingAllocationSettingsByPrefix(supabase);
  return rows
    .map((row) => parsePendingAllocationValue(row.value))
    .filter(Boolean)
    .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')) || a.cabang.localeCompare(b.cabang));
}

async function listPendingAllocationRows(supabase, options = {}) {
  const periode = String(options.periode || '').trim().slice(0, 7);
  const rows = await readAllPendingAllocationRows(supabase);
  return {
    rows: rows.filter((row) => {
      if (!periode) return true;
      return row.after_periode === periode || String(row.created_at || '').startsWith(periode + '-');
    }),
  };
}

async function upsertPendingAllocation(supabase, input) {
  const record = createPendingAllocationRecord(input);
  if (!record) {
    throw new Error('Data pending allocation tidak valid.');
  }

  const key = buildPendingAllocationKey(record.root_transfer_id);
  const { error } = await supabase.from('settings').upsert({
    key,
    value: JSON.stringify(record),
  });
  if (error) throw error;
  return record;
}

async function deletePendingAllocation(supabase, transferId) {
  const key = buildPendingAllocationKey(transferId);
  if (!key) {
    throw new Error('ID transfer tidak valid.');
  }

  const { error } = await supabase.from('settings').delete().eq('key', key);
  if (error) throw error;
}

module.exports = {
  NONCOD_PENDING_ALLOCATION_KEY_PREFIX,
  buildPendingAllocationKey,
  createPendingAllocationRecord,
  deletePendingAllocation,
  listPendingAllocationRows,
  normalizePendingAmount,
  normalizePendingBank,
  normalizePendingCabang,
  normalizePendingDate,
  normalizePendingProofPath,
  normalizePendingText,
  normalizePendingTransferId,
  parsePendingAllocationValue,
  upsertPendingAllocation,
};