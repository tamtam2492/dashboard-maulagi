const crypto = require('crypto');

const { normalizeBankName } = require('./_bank');
const { roundTransferNominal } = require('./_transfer-utils');

function createProofSignature(fileBuffer) {
  if (!Buffer.isBuffer(fileBuffer) || !fileBuffer.length) return '';
  return crypto.createHash('sha256').update(fileBuffer).digest('hex');
}

function buildProofSignatureKey(signature) {
  return 'proof_signature_' + String(signature || '').trim();
}

function buildProofSignaturePayload(options) {
  const signature = String(options && (options.signature || createProofSignature(options.fileBuffer)) || '').trim();

  return {
    signature,
    key: buildProofSignatureKey(signature),
    namaCabang: String(options && options.namaCabang || '').trim().toUpperCase(),
    tglInputan: String(options && options.tglInputan || '').trim(),
    namaBank: normalizeBankName(options && options.namaBank),
    nominal: Number.isFinite(roundTransferNominal(options && options.nominal))
      ? roundTransferNominal(options && options.nominal)
      : 0,
    fileName: String(options && options.fileName || '').trim(),
    mimeType: String(options && options.mimeType || '').trim(),
  };
}

function parseProofSignatureValue(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizeProofTransferIds(existingRecord) {
  const existing = existingRecord && typeof existingRecord === 'object' ? existingRecord : {};
  const ids = [];
  const primaryId = String(existing.transferId || '').trim();
  if (primaryId) ids.push(primaryId);

  const transferIds = Array.isArray(existing.transferIds) ? existing.transferIds : [];
  transferIds.forEach((value) => {
    const normalized = String(value || '').trim();
    if (normalized) ids.push(normalized);
  });

  return [...new Set(ids)];
}

function normalizeProofSplitRows(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => ({
      tgl_inputan: String(row && row.tgl_inputan || '').trim(),
      nominal: roundTransferNominal(row && row.nominal),
    }))
    .filter((row) => row.tgl_inputan && Number.isFinite(row.nominal) && row.nominal > 0);
}

function removeProofTransferIds(existingRecord, removedIds) {
  const existing = existingRecord && typeof existingRecord === 'object' ? { ...existingRecord } : null;
  if (!existing) return null;

  const removedSet = new Set((Array.isArray(removedIds) ? removedIds : [removedIds])
    .map((value) => String(value || '').trim())
    .filter(Boolean));

  if (!removedSet.size) return existing;

  const remainingIds = normalizeProofTransferIds(existing).filter((id) => !removedSet.has(id));
  if (!remainingIds.length) return null;

  return {
    ...existing,
    transferId: remainingIds[0],
    transferIds: remainingIds,
  };
}

function replaceProofTransferIds(existingRecord, oldTransferId, newTransfers) {
  const existing = existingRecord && typeof existingRecord === 'object' ? { ...existingRecord } : null;
  if (!existing) return null;

  const normalizedOldId = String(oldTransferId || '').trim();
  if (!normalizedOldId) return existing;

  const preservedIds = normalizeProofTransferIds(existing).filter((id) => id !== normalizedOldId);
  const normalizedRows = normalizeProofSplitRows(newTransfers);
  const newIds = normalizedRows
    .map((_, index) => String(newTransfers[index] && newTransfers[index].id || '').trim())
    .filter(Boolean);
  const nextIds = [...new Set([...preservedIds, ...newIds])];

  if (!nextIds.length) return null;

  const nextRecord = {
    ...existing,
    transferId: nextIds[0],
    transferIds: nextIds,
  };

  if (normalizedRows.length) {
    nextRecord.tglInputan = normalizedRows[0].tgl_inputan;
    nextRecord.tglInputanList = normalizedRows.map((row) => row.tgl_inputan);
    nextRecord.splitRows = normalizedRows;
  }

  return nextRecord;
}

async function listProofSignatureSettingsByTransferId(supabase, transferId) {
  const normalizedTransferId = String(transferId || '').trim();
  if (!supabase || !normalizedTransferId) return [];

  const { data, error } = await supabase
    .from('settings')
    .select('key, value')
    .like('key', 'proof_signature_%')
    .like('value', `%${normalizedTransferId}%`)
    .range(0, 200);

  if (error) throw error;

  return (data || []).reduce((result, row) => {
    const parsedValue = parseProofSignatureValue(row.value);
    if (!parsedValue) return result;
    if (!normalizeProofTransferIds(parsedValue).includes(normalizedTransferId)) return result;
    result.push({ key: row.key, value: parsedValue });
    return result;
  }, []);
}

async function listLiveProofTransferIds(supabase, existingRecord) {
  const transferIds = normalizeProofTransferIds(existingRecord);
  if (!supabase || !transferIds.length) return [];

  const { data, error } = await supabase
    .from('transfers')
    .select('id')
    .in('id', transferIds);

  if (error) throw error;

  const liveIdSet = new Set((data || []).map((row) => String(row.id || '').trim()).filter(Boolean));
  return transferIds.filter((id) => liveIdSet.has(id));
}

async function pruneProofSignatureRegistryByTransferIds(supabase, transferIds) {
  const normalizedIds = [...new Set((Array.isArray(transferIds) ? transferIds : [transferIds])
    .map((value) => String(value || '').trim())
    .filter(Boolean))];
  if (!supabase || !normalizedIds.length) return { updated: 0, deleted: 0 };

  const candidateMap = new Map();
  for (const transferId of normalizedIds) {
    const settings = await listProofSignatureSettingsByTransferId(supabase, transferId);
    settings.forEach((row) => {
      if (!candidateMap.has(row.key)) candidateMap.set(row.key, row.value);
    });
  }

  let updated = 0;
  let deleted = 0;

  for (const [key, value] of candidateMap.entries()) {
    const nextValue = removeProofTransferIds(value, normalizedIds);
    if (!nextValue) {
      const { error } = await supabase.from('settings').delete().eq('key', key);
      if (error) throw error;
      deleted += 1;
      continue;
    }

    if (JSON.stringify(nextValue) === JSON.stringify(value)) continue;

    const { error } = await supabase.from('settings').upsert({
      key,
      value: JSON.stringify(nextValue),
    });
    if (error) throw error;
    updated += 1;
  }

  return { updated, deleted };
}

async function replaceProofSignatureRegistryTransferIds(supabase, oldTransferId, newTransfers) {
  const normalizedOldId = String(oldTransferId || '').trim();
  if (!supabase || !normalizedOldId) return { updated: 0 };

  const settings = await listProofSignatureSettingsByTransferId(supabase, normalizedOldId);
  let updated = 0;

  for (const row of settings) {
    const nextValue = replaceProofTransferIds(row.value, normalizedOldId, newTransfers);
    if (!nextValue || JSON.stringify(nextValue) === JSON.stringify(row.value)) continue;

    const { error } = await supabase.from('settings').upsert({
      key: row.key,
      value: JSON.stringify(nextValue),
    });
    if (error) throw error;
    updated += 1;
  }

  return { updated };
}

function formatDateId(dateText) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateText || '').trim())) return '-';
  const [year, month, day] = String(dateText).trim().split('-');
  return `${day}/${month}/${year}`;
}

function formatNominalId(value) {
  return 'Rp ' + Number(value || 0).toLocaleString('id-ID');
}

function formatProofDuplicateMessage(existingRecord) {
  const existing = existingRecord || {};
  const cabang = String(existing.namaCabang || existing.nama_cabang || '').trim();
  const tanggal = String(existing.tglInputan || existing.tgl_inputan || '').trim();
  const nominal = Number(existing.nominal || 0);

  let message = 'Bukti transfer ini sudah pernah dipakai';
  if (cabang) message += ' untuk ' + cabang;
  if (tanggal) message += ' pada tanggal rekap ' + formatDateId(tanggal);
  if (nominal > 0) message += ' dengan nominal ' + formatNominalId(nominal);
  return message + '. Upload diblokir agar struk yang sama tidak dipakai ulang.';
}

module.exports = {
  buildProofSignatureKey,
  buildProofSignaturePayload,
  createProofSignature,
  formatProofDuplicateMessage,
  listLiveProofTransferIds,
  parseProofSignatureValue,
  normalizeProofTransferIds,
  pruneProofSignatureRegistryByTransferIds,
  removeProofTransferIds,
  replaceProofSignatureRegistryTransferIds,
  replaceProofTransferIds,
};