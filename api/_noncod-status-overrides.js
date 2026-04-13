const STATUS_OVERRIDE_KEY_PREFIX = 'noncod_status_override_';

function normalizeResi(value) {
  return String(value || '').trim().toUpperCase().slice(0, 50);
}

function normalizeStatusOverride(value) {
  return String(value || '').trim().toUpperCase().slice(0, 50);
}

function normalizeSearchQuery(value) {
  return String(value || '').trim().toUpperCase().slice(0, 50);
}

function buildStatusOverrideKey(nomorResi) {
  const normalizedResi = normalizeResi(nomorResi);
  return normalizedResi ? STATUS_OVERRIDE_KEY_PREFIX + normalizedResi : '';
}

function parseStatusOverrideValue(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    const nomorResi = normalizeResi(parsed && (parsed.nomor_resi || parsed.nomorResi));
    const statusTerakhir = normalizeStatusOverride(parsed && (parsed.status_terakhir || parsed.statusTerakhir || parsed.status));
    if (!nomorResi || !statusTerakhir) return null;
    return {
      nomor_resi: nomorResi,
      status_terakhir: statusTerakhir,
      updated_at: String(parsed.updated_at || parsed.updatedAt || '').trim() || null,
      periode: String(parsed.periode || '').trim().slice(0, 7),
      cabang: String(parsed.cabang || '').trim().toUpperCase().slice(0, 100),
      tanggal_buat: String(parsed.tanggal_buat || '').trim().slice(0, 10),
      metode_pembayaran: String(parsed.metode_pembayaran || '').trim().toLowerCase().slice(0, 30),
    };
  } catch {
    return null;
  }
}

function createStatusOverrideRecord(input) {
  const nomorResi = normalizeResi(input && input.nomor_resi);
  const statusTerakhir = normalizeStatusOverride(input && input.status_terakhir);
  if (!nomorResi || !statusTerakhir) return null;

  return {
    nomor_resi: nomorResi,
    status_terakhir: statusTerakhir,
    updated_at: new Date().toISOString(),
    periode: String((input && input.periode) || '').trim().slice(0, 7),
    cabang: String((input && input.cabang) || '').trim().toUpperCase().slice(0, 100),
    tanggal_buat: String((input && input.tanggal_buat) || '').trim().slice(0, 10),
    metode_pembayaran: String((input && input.metode_pembayaran) || '').trim().toLowerCase().slice(0, 30),
  };
}

function applyStatusOverrides(rows, overrideMap) {
  if (!Array.isArray(rows) || !rows.length || !(overrideMap instanceof Map) || !overrideMap.size) {
    return Array.isArray(rows) ? rows : [];
  }

  return rows.map((row) => {
    const nomorResi = normalizeResi(row && row.nomor_resi);
    const override = nomorResi ? overrideMap.get(nomorResi) : null;
    if (!override || !override.status_terakhir) return row;

    return {
      ...row,
      status_terakhir: override.status_terakhir,
      manual_status: true,
      manual_status_terakhir: override.status_terakhir,
      manual_status_updated_at: override.updated_at || null,
    };
  });
}

async function fetchOverrideSettingsByPrefix(supabase) {
  const allRows = [];
  let from = 0;

  while (true) {
    const { data, error } = await supabase
      .from('settings')
      .select('key, value')
      .like('key', STATUS_OVERRIDE_KEY_PREFIX + '%')
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

function buildOverrideMap(overrides) {
  const map = new Map();
  (overrides || []).forEach((override) => {
    if (!override || !override.nomor_resi) return;
    map.set(override.nomor_resi, override);
  });
  return map;
}

async function readAllStatusOverrides(supabase) {
  const rows = await fetchOverrideSettingsByPrefix(supabase);
  return rows
    .map((row) => parseStatusOverrideValue(row.value))
    .filter(Boolean)
    .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')) || a.nomor_resi.localeCompare(b.nomor_resi));
}

async function readStatusOverridesByResi(supabase, nomorResiList) {
  const keys = [...new Set((nomorResiList || [])
    .map((nomorResi) => buildStatusOverrideKey(nomorResi))
    .filter(Boolean))];

  if (!keys.length) return new Map();

  const overrides = [];
  for (let index = 0; index < keys.length; index += 100) {
    const batch = keys.slice(index, index + 100);
    const { data, error } = await supabase
      .from('settings')
      .select('key, value')
      .in('key', batch);
    if (error) throw error;
    (data || []).forEach((row) => {
      const parsed = parseStatusOverrideValue(row.value);
      if (parsed) overrides.push(parsed);
    });
  }

  return buildOverrideMap(overrides);
}

async function fetchRowsByResi(supabase, nomorResiList) {
  const normalizedResi = [...new Set((nomorResiList || [])
    .map((nomorResi) => normalizeResi(nomorResi))
    .filter(Boolean))];

  if (!normalizedResi.length) return [];

  const rows = [];
  for (let index = 0; index < normalizedResi.length; index += 100) {
    const batch = normalizedResi.slice(index, index + 100);
    const { data, error } = await supabase
      .from('noncod')
      .select('periode, tanggal_buat, nomor_resi, cabang, metode_pembayaran, status_terakhir, ongkir, total_pengiriman')
      .in('nomor_resi', batch)
      .order('periode', { ascending: false })
      .order('tanggal_buat', { ascending: false });
    if (error) throw error;
    rows.push(...(data || []));
  }

  return rows;
}

async function searchSyncRowsByResi(supabase, query, limit = 50) {
  const normalizedQuery = normalizeSearchQuery(query);
  if (!normalizedQuery) return [];

  const { data, error } = await supabase
    .from('noncod')
    .select('periode, tanggal_buat, nomor_resi, cabang, metode_pembayaran, status_terakhir, ongkir, total_pengiriman')
    .ilike('nomor_resi', '%' + normalizedQuery + '%')
    .order('periode', { ascending: false })
    .order('tanggal_buat', { ascending: false })
    .limit(Math.max(1, Math.min(Number(limit) || 50, 200)));

  if (error) throw error;
  return data || [];
}

function pickPreferredRow(rows, override) {
  const list = Array.isArray(rows) ? rows.slice() : [];
  if (!list.length) return null;

  list.sort((a, b) => {
    const aOverridePeriod = override && override.periode && a.periode === override.periode ? 1 : 0;
    const bOverridePeriod = override && override.periode && b.periode === override.periode ? 1 : 0;
    if (aOverridePeriod !== bOverridePeriod) return bOverridePeriod - aOverridePeriod;
    return String(b.periode || '').localeCompare(String(a.periode || '')) ||
      String(b.tanggal_buat || '').localeCompare(String(a.tanggal_buat || ''));
  });

  return list[0];
}

function groupRowsByResi(rows, overrideMap) {
  const grouped = new Map();

  (rows || []).forEach((row) => {
    const nomorResi = normalizeResi(row && row.nomor_resi);
    if (!nomorResi) return;
    if (!grouped.has(nomorResi)) grouped.set(nomorResi, []);
    grouped.get(nomorResi).push({ ...row, nomor_resi: nomorResi });
  });

  const picked = new Map();
  grouped.forEach((itemRows, nomorResi) => {
    const override = overrideMap instanceof Map ? overrideMap.get(nomorResi) : null;
    picked.set(nomorResi, pickPreferredRow(itemRows, override));
  });

  return picked;
}

function mergeRowWithOverride(row, override) {
  const nomorResi = normalizeResi((row && row.nomor_resi) || (override && override.nomor_resi));
  const sourceStatus = normalizeStatusOverride(row && row.status_terakhir);
  const manualStatus = normalizeStatusOverride(override && override.status_terakhir);

  return {
    nomor_resi: nomorResi,
    periode: String((row && row.periode) || (override && override.periode) || '').trim().slice(0, 7),
    cabang: String((row && row.cabang) || (override && override.cabang) || '').trim().toUpperCase().slice(0, 100),
    tanggal_buat: String((row && row.tanggal_buat) || (override && override.tanggal_buat) || '').trim().slice(0, 10),
    metode_pembayaran: String((row && row.metode_pembayaran) || (override && override.metode_pembayaran) || '').trim().toLowerCase().slice(0, 30),
    ongkir: Number((row && row.ongkir) || 0),
    total_pengiriman: Number((row && row.total_pengiriman) || 0),
    source_status_terakhir: sourceStatus,
    manual_status_terakhir: manualStatus,
    effective_status_terakhir: manualStatus || sourceStatus,
    override_active: !!manualStatus,
    updated_at: override && override.updated_at ? override.updated_at : null,
    found_in_sync: !!row,
  };
}

function sortMergedRows(rows) {
  return (rows || []).slice().sort((a, b) => {
    const overrideDiff = Number(!!b.override_active) - Number(!!a.override_active);
    if (overrideDiff !== 0) return overrideDiff;
    return String(b.updated_at || '').localeCompare(String(a.updated_at || '')) ||
      String(b.periode || '').localeCompare(String(a.periode || '')) ||
      String(b.tanggal_buat || '').localeCompare(String(a.tanggal_buat || '')) ||
      String(a.nomor_resi || '').localeCompare(String(b.nomor_resi || ''));
  });
}

async function listStatusOverrideRows(supabase, options = {}) {
  const query = normalizeSearchQuery(options.query);
  const limit = Math.max(1, Math.min(Number(options.limit) || 100, 200));
  const overrides = await readAllStatusOverrides(supabase);
  const overrideMap = buildOverrideMap(overrides);

  if (!query) {
    const overrideSlice = overrides.slice(0, limit);
    const liveRows = await fetchRowsByResi(supabase, overrideSlice.map((item) => item.nomor_resi));
    const rowsByResi = groupRowsByResi(liveRows, overrideMap);
    const rows = overrideSlice.map((override) => mergeRowWithOverride(rowsByResi.get(override.nomor_resi) || null, override));

    return {
      mode: 'overrides',
      query: '',
      total: rows.length,
      rows: sortMergedRows(rows),
    };
  }

  const searchRows = await searchSyncRowsByResi(supabase, query, limit);
  const overrideMatches = overrides.filter((override) => override.nomor_resi.includes(query));
  const rowsByResi = groupRowsByResi(searchRows, overrideMap);
  const nomorResiList = [...new Set([
    ...Array.from(rowsByResi.keys()),
    ...overrideMatches.map((override) => override.nomor_resi),
  ])].slice(0, limit);

  const rows = nomorResiList.map((nomorResi) => mergeRowWithOverride(rowsByResi.get(nomorResi) || null, overrideMap.get(nomorResi) || null));

  return {
    mode: 'search',
    query,
    total: rows.length,
    rows: sortMergedRows(rows),
  };
}

async function upsertStatusOverride(supabase, input) {
  const record = createStatusOverrideRecord(input);
  if (!record) {
    throw new Error('Nomor resi dan status manual wajib diisi.');
  }

  const { error } = await supabase
    .from('settings')
    .upsert({
      key: buildStatusOverrideKey(record.nomor_resi),
      value: JSON.stringify(record),
    });

  if (error) throw error;
  return record;
}

async function deleteStatusOverride(supabase, nomorResi) {
  const key = buildStatusOverrideKey(nomorResi);
  if (!key) {
    throw new Error('Nomor resi tidak valid.');
  }

  const { error } = await supabase
    .from('settings')
    .delete()
    .eq('key', key);

  if (error) throw error;
  return true;
}

module.exports = {
  STATUS_OVERRIDE_KEY_PREFIX,
  applyStatusOverrides,
  buildStatusOverrideKey,
  createStatusOverrideRecord,
  deleteStatusOverride,
  listStatusOverrideRows,
  normalizeResi,
  normalizeSearchQuery,
  normalizeStatusOverride,
  parseStatusOverrideValue,
  readAllStatusOverrides,
  readStatusOverridesByResi,
  upsertStatusOverride,
};