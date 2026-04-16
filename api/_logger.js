const { getSupabase } = require('./_supabase');
const { queueOpsNotification, shouldNotifySource } = require('./_ops-notifier');

/**
 * Log an error to the error_logs table (fire-and-forget).
 * @param {string} source - API source (e.g. 'input', 'transfer')
 * @param {string} message - Error message
 * @param {object} [meta] - Optional metadata (method, path, etc.)
 */
function logError(source, message, meta = {}) {
  try {
    const sb = getSupabase();
    sb.from('error_logs').insert({
      source,
      message: String(message).slice(0, 1000),
      meta: JSON.stringify(meta).slice(0, 2000),
    }).then(() => {}).catch(() => {});
  } catch (_) { /* silent */ }

  if (shouldNotifySource(source)) {
    queueOpsNotification({
      source,
      eventType: 'error_log',
      severity: 'error',
      title: 'Error ' + String(source || '').trim(),
      message: String(message || '').trim(),
      meta,
    });
  }
}

module.exports = { logError };
