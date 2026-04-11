const { getSupabase } = require('./_supabase');

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
}

module.exports = { logError };
