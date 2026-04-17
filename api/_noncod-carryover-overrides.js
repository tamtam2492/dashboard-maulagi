const NONCOD_CARRYOVER_OVERRIDE_KEY_PREFIX = 'noncod_carryover_override_';
const MAX_NONCOD_CARRYOVER_AMOUNT = 100000;
const CARRYOVER_REASON_MAX_LENGTH = 200;

function normalizeCarryoverTransferId(value) {
  return String(value || '').trim().slice(0, 64);
}

function normalizeCarryoverCabang(value) {
  return String(value || '').trim().toUpperCase().slice(0, 100);
}

function normalizeCarryoverDate(value) {
  const normalized = String(value || '').trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(normalized) ? normalized : '';
}

function normalizeCarryoverReason(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, CARRYOVER_REASON_MAX_LENGTH);
}

function normalizeCarryoverAmount(value) {
  const amount = Math.round(Number(value || 0));
  return Number.isFinite(amount) && amount > 0 ? amount : 0;
}

function normalizeCarryoverBank(value) {
  return String(value || '').trim().toUpperCase().slice(0, 30);
}

function buildCarryoverOverrideKey(transferId) {
  const normalizedTransferId = normalizeCarryoverTransferId(transferId);
  return normalizedTransferId ? NONCOD_CARRYOVER_OVERRIDE_KEY_PREFIX + normalizedTransferId : '';
}

function addDaysToCarryoverDate(dateText, days) {
  const normalizedDate = normalizeCarryoverDate(dateText);
  if (!normalizedDate) return '';

  const [year, month, day] = normalizedDate.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + Number(days || 0));
  return date.toISOString().slice(0, 10);
}

function isCarryoverNextDay(targetDate, transferDate) {
  const normalizedTargetDate = normalizeCarryoverDate(targetDate);
  const normalizedTransferDate = normalizeCarryoverDate(transferDate);
  return !!normalizedTargetDate && !!normalizedTransferDate && addDaysToCarryoverDate(normalizedTargetDate, 1) === normalizedTransferDate;
}

function createCarryoverOverrideRecord(input) {
  const transferId = normalizeCarryoverTransferId(input && input.transfer_id);
  const cabang = normalizeCarryoverCabang(input && input.cabang);
  const targetDate = normalizeCarryoverDate(input && input.target_date);
  const transferDate = normalizeCarryoverDate(input && input.transfer_date);
  const nominal = normalizeCarryoverAmount(input && input.nominal);
  const reason = normalizeCarryoverReason(input && input.reason);
  const transferBank = normalizeCarryoverBank(input && input.transfer_bank);

  if (!transferId || !cabang || !targetDate || !transferDate || !reason) return null;
  if (!isCarryoverNextDay(targetDate, transferDate)) return null;
  if (!(nominal > 0) || nominal > MAX_NONCOD_CARRYOVER_AMOUNT) return null;

  return {
    transfer_id: transferId,
    cabang,
    target_date: targetDate,
    transfer_date: transferDate,
    target_periode: targetDate.slice(0, 7),
    transfer_periode: transferDate.slice(0, 7),
    nominal,
    reason,
    transfer_bank: transferBank,
    updated_at: new Date().toISOString(),
  };
}

function parseCarryoverOverrideValue(value) {
  if (!value) return null;

  try {
    const parsed = JSON.parse(value);
    const record = createCarryoverOverrideRecord(parsed);
    if (!record) return null;
    record.updated_at = String(parsed.updated_at || parsed.updatedAt || '').trim() || record.updated_at;
    return record;
  } catch {
    return null;
  }
}

async function fetchCarryoverSettingsByPrefix(supabase) {
  const allRows = [];
  let from = 0;

  while (true) {
    const { data, error } = await supabase
      .from('settings')
      .select('key, value')
      .like('key', NONCOD_CARRYOVER_OVERRIDE_KEY_PREFIX + '%')
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

async function readAllCarryoverOverrides(supabase) {
  const rows = await fetchCarryoverSettingsByPrefix(supabase);
  return rows
    .map((row) => parseCarryoverOverrideValue(row.value))
    .filter(Boolean)
    .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')) || a.cabang.localeCompare(b.cabang));
}

async function listCarryoverOverrideRows(supabase, options = {}) {
  const periode = String(options.periode || '').trim().slice(0, 7);
  const rows = await readAllCarryoverOverrides(supabase);

  return {
    rows: rows.filter((row) => {
      if (!periode) return true;
      return row.target_periode === periode || row.transfer_periode === periode;
    }),
  };
}

async function upsertCarryoverOverride(supabase, input) {
  const record = createCarryoverOverrideRecord(input);
  if (!record) {
    throw new Error('Data carry-over H+1 tidak valid.');
  }

  const key = buildCarryoverOverrideKey(record.transfer_id);
  const { error } = await supabase.from('settings').upsert({
    key,
    value: JSON.stringify(record),
  });

  if (error) throw error;
  return record;
}

async function deleteCarryoverOverride(supabase, transferId) {
  const key = buildCarryoverOverrideKey(transferId);
  if (!key) {
    throw new Error('ID transfer tidak valid.');
  }

  const { error } = await supabase.from('settings').delete().eq('key', key);
  if (error) throw error;
}

module.exports = {
  NONCOD_CARRYOVER_OVERRIDE_KEY_PREFIX,
  MAX_NONCOD_CARRYOVER_AMOUNT,
  addDaysToCarryoverDate,
  buildCarryoverOverrideKey,
  createCarryoverOverrideRecord,
  deleteCarryoverOverride,
  isCarryoverNextDay,
  listCarryoverOverrideRows,
  normalizeCarryoverAmount,
  normalizeCarryoverCabang,
  normalizeCarryoverDate,
  normalizeCarryoverReason,
  normalizeCarryoverTransferId,
  parseCarryoverOverrideValue,
  upsertCarryoverOverride,
};