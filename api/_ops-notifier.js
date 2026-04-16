const DEFAULT_TIMEOUT_MS = 2500;

function normalizeText(value, maxLength = 1000) {
  return String(value || '').trim().slice(0, maxLength);
}

function normalizeMeta(meta) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return {};
  const normalized = {};
  for (const [key, value] of Object.entries(meta)) {
    if (!key) continue;
    if (value === undefined) continue;
    if (value === null) {
      normalized[key] = null;
      continue;
    }
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      normalized[key] = value;
      continue;
    }
    normalized[key] = normalizeText(JSON.stringify(value), 400);
  }
  return normalized;
}

function parseSourceAllowlist(raw) {
  return new Set(
    String(raw || '')
      .split(',')
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean)
  );
}

function getNotifierConfig(env = process.env) {
  return {
    url: normalizeText(env.TELEGRAM_NOTIFY_URL, 500),
    secret: normalizeText(env.TELEGRAM_NOTIFY_SECRET, 500),
    service: normalizeText(env.TELEGRAM_NOTIFY_SERVICE, 120) || 'dashboard-maulagi',
    sourceAllowlist: parseSourceAllowlist(env.TELEGRAM_NOTIFY_SOURCES),
    timeoutMs: Number(env.TELEGRAM_NOTIFY_TIMEOUT_MS || DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
  };
}

function isOpsNotifierEnabled(env = process.env) {
  const config = getNotifierConfig(env);
  return !!(config.url && config.secret);
}

function shouldNotifySource(source, env = process.env) {
  const config = getNotifierConfig(env);
  if (!config.url || !config.secret) return false;
  if (!config.sourceAllowlist.size) return false;
  return config.sourceAllowlist.has(String(source || '').trim().toLowerCase());
}

function buildNotifierPayload(options = {}, env = process.env) {
  const config = getNotifierConfig(env);
  return {
    source: normalizeText(options.source, 80),
    eventType: normalizeText(options.eventType || 'error', 80),
    severity: normalizeText(options.severity || 'error', 32),
    title: normalizeText(options.title || 'Ops Alert', 140),
    message: normalizeText(options.message, 1200),
    service: config.service,
    meta: normalizeMeta(options.meta),
    timestamp: new Date().toISOString(),
  };
}

async function sendOpsNotification(options = {}, env = process.env, fetchImpl = globalThis.fetch) {
  const config = getNotifierConfig(env);
  if (!config.url || !config.secret) return { skipped: true, reason: 'disabled' };
  if (typeof fetchImpl !== 'function') return { skipped: true, reason: 'fetch_unavailable' };

  const payload = buildNotifierPayload(options, env);
  if (!payload.message) return { skipped: true, reason: 'empty_message' };

  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timeoutId = controller ? setTimeout(() => controller.abort(), config.timeoutMs) : null;

  try {
    const response = await fetchImpl(config.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Ops-Secret': config.secret,
      },
      body: JSON.stringify(payload),
      signal: controller ? controller.signal : undefined,
    });

    return {
      skipped: false,
      ok: response.ok,
      status: response.status,
    };
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function queueOpsNotification(options = {}, env = process.env, fetchImpl = globalThis.fetch) {
  if (!isOpsNotifierEnabled(env)) return false;
  sendOpsNotification(options, env, fetchImpl).catch(() => {});
  return true;
}

module.exports = {
  buildNotifierPayload,
  getNotifierConfig,
  isOpsNotifierEnabled,
  normalizeMeta,
  parseSourceAllowlist,
  queueOpsNotification,
  sendOpsNotification,
  shouldNotifySource,
};