const DEFAULT_TIMEOUT_MS = 10000;
const ERROR_SEVERITIES = new Set(['error', 'critical']);
const NON_ERROR_EVENT_ALLOWLIST = new Set(['manual_test']);

function normalizeText(value, maxLength = 1000) {
  return String(value || '').trim().slice(0, maxLength);
}

function normalizeSeverity(value) {
  return normalizeText(value || 'error', 32).toLowerCase() || 'error';
}

function normalizeEventType(value) {
  return normalizeText(value || 'error', 80).toLowerCase() || 'error';
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
  if (config.sourceAllowlist.has('*') || config.sourceAllowlist.has('all')) return true;
  return config.sourceAllowlist.has(String(source || '').trim().toLowerCase());
}

function shouldDispatchNotification(options = {}) {
  const severity = normalizeSeverity(options.severity || 'error');
  const eventType = normalizeEventType(options.eventType || 'error');
  if (ERROR_SEVERITIES.has(severity)) return true;
  return NON_ERROR_EVENT_ALLOWLIST.has(eventType);
}

function buildNotifierPayload(options = {}, env = process.env) {
  const config = getNotifierConfig(env);
  const source = normalizeText(options.source, 80).toLowerCase();
  const eventType = normalizeEventType(options.eventType || 'error');
  const severity = normalizeSeverity(options.severity || 'error');
  return {
    source,
    eventType,
    severity,
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
  if (!shouldNotifySource(options.source, env)) return { skipped: true, reason: 'source_filtered' };
  if (!shouldDispatchNotification(options)) return { skipped: true, reason: 'severity_filtered' };

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
  if (!shouldNotifySource(options.source, env)) return false;
  if (!shouldDispatchNotification(options)) return false;
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
  shouldDispatchNotification,
  shouldNotifySource,
};
