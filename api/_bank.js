const BANK_ALIASES = new Map([
  ['MTRANSFER', 'BCA'],
  ['MTRANSFERBCA', 'BCA'],
  ['MBCA', 'BCA'],
  ['BCAMOBILE', 'BCA'],
  ['MBANKINGBCA', 'BCA'],
  ['MYBANK', 'BCA'],
]);

function normalizeBankName(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const upper = raw.toUpperCase();
  const compact = upper.replace(/[^A-Z0-9]/g, '');
  return BANK_ALIASES.get(compact) || upper;
}

module.exports = { normalizeBankName };