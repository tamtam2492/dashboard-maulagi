const TRANSFER_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function normalizeText(value) {
  return String(value ?? '').trim();
}

function isValidTransferDate(dateText) {
  return TRANSFER_DATE_RE.test(normalizeText(dateText));
}

function getPeriodeFromDate(dateText) {
  const normalized = normalizeText(dateText);
  return isValidTransferDate(normalized) ? normalized.slice(0, 7) : '';
}

function parseTransferNominal(value) {
  const normalized = normalizeText(value).replace(/,/g, '');
  const numeric = Number.parseFloat(normalized);
  return Number.isFinite(numeric) ? numeric : NaN;
}

function isPositiveTransferNominal(value) {
  const numeric = parseTransferNominal(value);
  return Number.isFinite(numeric) && numeric > 0;
}

function roundTransferNominal(value) {
  const numeric = parseTransferNominal(value);
  return Number.isFinite(numeric) ? Math.round(numeric) : NaN;
}

function normalizeTransferKet(value) {
  if (value === undefined) return undefined;
  const normalized = normalizeText(value);
  return normalized || null;
}

function buildTransferUpdate(tgl_inputan, ket, nominal) {
  const normalizedDate = normalizeText(tgl_inputan);
  const periode = getPeriodeFromDate(normalizedDate);
  if (!periode) return null;
  const update = { tgl_inputan: normalizedDate, periode };
  if (ket !== undefined) update.ket = normalizeTransferKet(ket);
  if (nominal !== undefined) {
    const roundedNominal = roundTransferNominal(nominal);
    if (!Number.isFinite(roundedNominal) || !(roundedNominal > 0)) return null;
    update.nominal = roundedNominal;
  }
  return update;
}

module.exports = {
  buildTransferUpdate,
  getPeriodeFromDate,
  isPositiveTransferNominal,
  isValidTransferDate,
  normalizeTransferKet,
  parseTransferNominal,
  roundTransferNominal,
};