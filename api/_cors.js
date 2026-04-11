/**
 * Shared CORS helper for all API routes.
 * Sets proper headers and handles OPTIONS preflight.
 * Returns true if the request was a preflight (caller should return early).
 */
function normalizeOrigin(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function cors(req, res, { methods = 'GET, OPTIONS', headers = 'Content-Type' } = {}) {
  const origin = normalizeOrigin(req.headers.origin || '');
  const allowed = [
    process.env.VERCEL_URL ? 'https://' + process.env.VERCEL_URL : '',
    process.env.ALLOWED_ORIGIN || '',
  ].map(normalizeOrigin).filter(Boolean);

  if (allowed.length && allowed.some(o => origin === o)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  // If no allowed origins configured (dev), allow same-origin only (no header = browser blocks cross-origin)

  res.setHeader('Access-Control-Allow-Methods', methods);
  res.setHeader('Access-Control-Allow-Headers', headers);

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return true;
  }
  return false;
}

module.exports = { cors };
