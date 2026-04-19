function normalizeText(value, maxLength = 200) {
  return String(value || '').trim().slice(0, maxLength);
}

function normalizeRequestMethod(value) {
  return normalizeText(value, 16).toUpperCase();
}

function normalizeQueryFlag(value) {
  return normalizeText(value, 16) === '1';
}

function normalizeBoundedInt(value, options = {}) {
  const fallback = Number.isFinite(Number(options.fallback)) ? Number(options.fallback) : 0;
  const min = Number.isFinite(Number(options.min)) ? Number(options.min) : Number.MIN_SAFE_INTEGER;
  const max = Number.isFinite(Number(options.max)) ? Number(options.max) : Number.MAX_SAFE_INTEGER;
  const parsed = Number.parseInt(normalizeText(value, 40), 10);

  if (!Number.isFinite(parsed)) return fallback;
  if (parsed < min) return min;
  if (parsed > max) return max;
  return parsed;
}

function ensureAllowedMethod(req, res, methods) {
  const allowedMethods = (Array.isArray(methods) ? methods : [methods])
    .map((method) => normalizeRequestMethod(method))
    .filter(Boolean);
  const requestMethod = normalizeRequestMethod(req && req.method);

  if (allowedMethods.includes(requestMethod)) return true;
  res.status(405).json({ error: 'Method not allowed.' });
  return false;
}

module.exports = {
  ensureAllowedMethod,
  normalizeBoundedInt,
  normalizeQueryFlag,
  normalizeRequestMethod,
  normalizeText,
};