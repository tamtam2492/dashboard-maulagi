const { cors } = require('./_cors');
const { logError, logFrontendErrorAsync } = require('./_logger');
const { rateLimit } = require('./_ratelimit');

const frontendLogLimiter = rateLimit({ windowMs: 60 * 1000, max: 20 });
const ALLOWED_FRONTEND_SOURCES = new Set([
  'frontend-admin',
  'frontend-dashboard',
  'frontend-index',
  'frontend-input',
  'frontend-noncod',
  'frontend-rekap',
]);

function normalizeText(value, maxLength = 1000) {
  return String(value || '').trim().slice(0, maxLength);
}

function normalizeOrigin(value) {
  return normalizeText(value, 300).replace(/\/+$/, '');
}

function extractOrigin(value) {
  try {
    const url = new URL(String(value || '').trim());
    return normalizeOrigin(url.origin);
  } catch {
    return '';
  }
}

function getAllowedOrigins(req) {
  const forwardedProto = normalizeText(req.headers['x-forwarded-proto'], 16).split(',')[0] || 'https';
  const host = normalizeText(req.headers.host, 200);
  return [
    process.env.VERCEL_URL ? 'https://' + process.env.VERCEL_URL : '',
    process.env.ALLOWED_ORIGIN || '',
    host ? `${forwardedProto}://${host}` : '',
  ].map(normalizeOrigin).filter(Boolean);
}

function isTrustedFetchMetadataRequest(req) {
  const site = normalizeText(req.headers['sec-fetch-site'], 40).toLowerCase();
  const mode = normalizeText(req.headers['sec-fetch-mode'], 40).toLowerCase();
  if (site !== 'same-origin') return false;
  if (!mode) return true;
  return mode === 'same-origin' || mode === 'cors' || mode === 'no-cors';
}

function isTrustedFrontendRequest(req) {
  const allowedOrigins = getAllowedOrigins(req);
  if (!allowedOrigins.length) return true;

  const origin = normalizeOrigin(req.headers.origin || '');
  const refererOrigin = extractOrigin(req.headers.referer || '');
  if ([origin, refererOrigin].some((value) => value && allowedOrigins.includes(value))) {
    return true;
  }

  return isTrustedFetchMetadataRequest(req);
}

function normalizeFrontendSource(value) {
  const source = normalizeText(value, 80).toLowerCase();
  return ALLOWED_FRONTEND_SOURCES.has(source) ? source : '';
}

function normalizeOptionalNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function buildFrontendMeta(req, body, source) {
  const path = normalizeText(body.path, 200);
  const url = normalizeText(body.url, 400);
  const action = normalizeText(body.action, 120);
  const component = normalizeText(body.component, 120);
  const line = normalizeOptionalNumber(body.line);
  const column = normalizeOptionalNumber(body.column);
  const meta = {
    page: source.replace(/^frontend-/, ''),
    path,
    url,
    action,
    component,
    line,
    column,
    referrer: normalizeText(req.headers.referer, 300),
    userAgent: normalizeText(req.headers['user-agent'], 180),
  };

  return Object.fromEntries(Object.entries(meta).filter(([, value]) => value !== undefined && value !== ''));
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (cors(req, res, { methods: 'POST, OPTIONS', headers: 'Content-Type, X-Admin-Token' })) return;

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  if (await frontendLogLimiter(req, res)) return;
  if (!isTrustedFrontendRequest(req)) {
    return res.status(403).json({ error: 'Origin tidak diizinkan.' });
  }

  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const source = normalizeFrontendSource(body.source);
    if (!source) {
      return res.status(400).json({ error: 'Source frontend tidak valid.' });
    }

    const message = normalizeText(body.message, 1200);
    if (!message) {
      return res.status(400).json({ error: 'Message wajib diisi.' });
    }

    await logFrontendErrorAsync(source, message, buildFrontendMeta(req, body, source));
    return res.status(202).json({ ok: true });
  } catch (err) {
    console.error(err);
    logError('frontend-log', err.message, { method: 'POST' });
    return res.status(500).json({ error: 'Gagal mencatat error frontend.' });
  }
};

module.exports.isTrustedFrontendRequest = isTrustedFrontendRequest;
