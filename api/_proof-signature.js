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
  parseProofSignatureValue,
};