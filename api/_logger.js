const { getSupabase } = require('./_supabase');
const { queueOpsNotification, sendOpsNotification, shouldNotifySource } = require('./_ops-notifier');

function normalizeText(value, maxLength = 1000) {
  return String(value || '').trim().slice(0, maxLength);
}

function normalizeMeta(meta) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return {};
  return { ...meta };
}

function sanitizeSource(source, fallback = 'backend') {
  return normalizeText(source, 80).toLowerCase() || fallback;
}

function createEventId(source) {
  const safeSource = normalizeText(source, 40)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'backend';
  return `ops_${safeSource}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function buildErrorTitle(channel, source, meta = {}) {
  const channelLabel = normalizeText(channel, 24).toUpperCase() || 'BACKEND';
  const sourceLabel = normalizeText(source, 80).toUpperCase() || 'BACKEND';
  const method = normalizeText(meta.method, 16).toUpperCase();
  const path = normalizeText(meta.path, 120);
  const page = normalizeText(meta.page, 80).toUpperCase();
  const action = normalizeText(meta.action, 80).toUpperCase();
  const requestLabel = [method, path].filter(Boolean).join(' ').trim();
  const segments = [channelLabel, 'ERROR', sourceLabel];
  if (requestLabel) segments.push(requestLabel);
  else if (page) segments.push(page);
  else if (action) segments.push(action);
  return segments.join(' • ');
}

function insertErrorLog(source, message, meta) {
  try {
    const sb = getSupabase();
    sb.from('error_logs').insert({
      source,
      message: message.slice(0, 1000),
      meta: JSON.stringify(meta).slice(0, 2000),
    }).then(() => {}).catch(() => {});
  } catch (_) { /* silent */ }
}

async function insertErrorLogAsync(source, message, meta) {
  const sb = getSupabase();
  const { error } = await sb.from('error_logs').insert({
    source,
    message: message.slice(0, 1000),
    meta: JSON.stringify(meta).slice(0, 2000),
  });
  if (error) throw error;
}

function dispatchErrorNotification(channel, source, eventType, message, meta) {
  if (!shouldNotifySource(source)) return;
  queueOpsNotification({
    source,
    eventType,
    severity: 'error',
    title: buildErrorTitle(channel, source, meta),
    message,
    meta,
  });
}

async function dispatchErrorNotificationAsync(channel, source, eventType, message, meta) {
  if (!shouldNotifySource(source)) return { skipped: true, reason: 'source_filtered' };
  return sendOpsNotification({
    source,
    eventType,
    severity: 'error',
    title: buildErrorTitle(channel, source, meta),
    message,
    meta,
  });
}

/**
 * Log an error to the error_logs table (fire-and-forget).
 * @param {string} source - API source (e.g. 'input', 'transfer')
 * @param {string} message - Error message
 * @param {object} [meta] - Optional metadata (method, path, etc.)
 */
function logError(source, message, meta = {}) {
  const safeSource = sanitizeSource(source, 'backend');
  const safeMessage = normalizeText(message, 1200);
  const safeMeta = normalizeMeta(meta);
  const eventId = createEventId(safeSource);
  const storedMeta = { ...safeMeta, eventId };

  insertErrorLog(safeSource, safeMessage, storedMeta);
  dispatchErrorNotification('backend', safeSource, 'backend_error', safeMessage, storedMeta);
}

function logFrontendError(source, message, meta = {}) {
  const safeSource = sanitizeSource(source, 'frontend');
  const safeMessage = normalizeText(message, 1200);
  const safeMeta = normalizeMeta(meta);
  const page = safeSource.replace(/^frontend-/, '') || 'app';
  const eventId = createEventId(safeSource);
  const storedMeta = {
    page,
    ...safeMeta,
    eventId,
  };

  insertErrorLog(safeSource, safeMessage, storedMeta);
  dispatchErrorNotification('frontend', safeSource, 'frontend_error', safeMessage, storedMeta);
}

async function logFrontendErrorAsync(source, message, meta = {}) {
  const safeSource = sanitizeSource(source, 'frontend');
  const safeMessage = normalizeText(message, 1200);
  const safeMeta = normalizeMeta(meta);
  const page = safeSource.replace(/^frontend-/, '') || 'app';
  const eventId = createEventId(safeSource);
  const storedMeta = {
    page,
    ...safeMeta,
    eventId,
  };

  await insertErrorLogAsync(safeSource, safeMessage, storedMeta);
  return dispatchErrorNotificationAsync('frontend', safeSource, 'frontend_error', safeMessage, storedMeta);
}

module.exports = { logError, logFrontendError, logFrontendErrorAsync };
