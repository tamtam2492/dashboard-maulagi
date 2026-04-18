const NONCOD_CABANG_HOLD_KEY_PREFIX = 'noncod_cabang_hold_';
const HOLD_TEXT_MAX_LENGTH = 200;
const HOLD_PROOF_PATH_MAX_LENGTH = 255;

function normalizeCabangHoldTransferId(value) {
  return String(value || '').trim().slice(0, 64);
}

function normalizeCabangHoldCabang(value) {
  return String(value || '').trim().toUpperCase().slice(0, 100);
}

function normalizeCabangHoldAmount(value) {
  const amount = Math.round(Number(value || 0));
  return Number.isFinite(amount) && amount > 0 ? amount : 0;
}

function normalizeCabangHoldText(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, HOLD_TEXT_MAX_LENGTH);
}

function normalizeCabangHoldBank(value) {
  return String(value || '').trim().toUpperCase().slice(0, 30);
}

function normalizeCabangHoldProofPath(value) {
  return String(value || '').trim().slice(0, HOLD_PROOF_PATH_MAX_LENGTH);
}

function normalizeCabangHoldTimestamp(value, fallback = '') {
  const normalized = String(value || '').trim();
  if (/^\d{4}-\d{2}-\d{2}T/.test(normalized)) return normalized;
  return fallback || '';
}

function buildCabangHoldKey(transferId) {
  const normalizedTransferId = normalizeCabangHoldTransferId(transferId);
  return normalizedTransferId ? NONCOD_CABANG_HOLD_KEY_PREFIX + normalizedTransferId : '';
}

function createCabangHoldRecord(input) {
  const rootTransferId = normalizeCabangHoldTransferId(input && input.root_transfer_id);
  const cabang = normalizeCabangHoldCabang(input && input.cabang);
  const nominal = normalizeCabangHoldAmount(input && input.nominal);
  const reason = normalizeCabangHoldText(input && input.reason);
  const ket = normalizeCabangHoldText(input && input.ket);
  const transferBank = normalizeCabangHoldBank(input && input.transfer_bank);
  const buktiUrl = normalizeCabangHoldProofPath(input && input.bukti_url);
  const nowIso = new Date().toISOString();
  const timestamp = normalizeCabangHoldTimestamp(input && input.timestamp, nowIso);
  const createdAt = normalizeCabangHoldTimestamp(input && input.created_at, nowIso);
  const updatedAt = normalizeCabangHoldTimestamp(input && input.updated_at, nowIso);

  if (!rootTransferId || !cabang) return null;
  if (!(nominal > 0)) return null;

  return {
    root_transfer_id: rootTransferId,
    cabang,
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

function parseCabangHoldValue(value) {
  if (!value) return null;

  try {
    const parsed = JSON.parse(value);
    return createCabangHoldRecord(parsed);
  } catch {
    return null;
  }
}

async function fetchCabangHoldSettingsByPrefix(supabase) {
  const allRows = [];
  let from = 0;

  while (true) {
    const { data, error } = await supabase
      .from('settings')
      .select('key, value')
      .like('key', NONCOD_CABANG_HOLD_KEY_PREFIX + '%')
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

async function readAllCabangHoldRows(supabase) {
  const rows = await fetchCabangHoldSettingsByPrefix(supabase);
  return rows
    .map((row) => parseCabangHoldValue(row.value))
    .filter(Boolean)
    .sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')) || a.cabang.localeCompare(b.cabang));
}

async function listCabangHoldRows(supabase, options = {}) {
  const normalizedCabang = normalizeCabangHoldCabang(options.cabang);
  const rows = await readAllCabangHoldRows(supabase);
  return {
    rows: rows.filter((row) => (!normalizedCabang || row.cabang === normalizedCabang)),
  };
}

async function readCabangHoldRowsByCabang(supabase, cabang) {
  const result = await listCabangHoldRows(supabase, { cabang });
  return result.rows;
}

async function upsertCabangHold(supabase, input) {
  const record = createCabangHoldRecord(input);
  if (!record) {
    throw new Error('Data hold cabang tidak valid.');
  }

  const key = buildCabangHoldKey(record.root_transfer_id);
  const { error } = await supabase.from('settings').upsert({
    key,
    value: JSON.stringify(record),
  });
  if (error) throw error;
  return record;
}

async function deleteCabangHold(supabase, transferId) {
  const key = buildCabangHoldKey(transferId);
  if (!key) {
    throw new Error('ID transfer hold tidak valid.');
  }

  const { error } = await supabase.from('settings').delete().eq('key', key);
  if (error) throw error;
}

module.exports = {
  NONCOD_CABANG_HOLD_KEY_PREFIX,
  buildCabangHoldKey,
  createCabangHoldRecord,
  deleteCabangHold,
  listCabangHoldRows,
  normalizeCabangHoldAmount,
  normalizeCabangHoldBank,
  normalizeCabangHoldCabang,
  normalizeCabangHoldProofPath,
  normalizeCabangHoldText,
  normalizeCabangHoldTransferId,
  parseCabangHoldValue,
  readCabangHoldRowsByCabang,
  upsertCabangHold,
};
