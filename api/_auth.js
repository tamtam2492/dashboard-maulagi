const crypto = require('crypto');
const { getSupabase } = require('./_supabase');
const { clearSessionCookie, readSessionCookies } = require('./_session-cookie');

/**
 * Cek session viewer tanpa mengirim response.
 * @returns {{ cabang: string, role: 'viewer' } | null}
 */
async function getViewerSession(req) {
  const headerToken = String(req.headers['x-admin-token'] || '').trim();
  const cookieMatch = headerToken ? null : (readSessionCookies(req, ['viewer'])[0] || null);
  const token = headerToken || (cookieMatch && cookieMatch.token) || '';
  if (!token) return null;
  try {
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const supabase = getSupabase();
    const { data } = await supabase
      .from('settings')
      .select('value')
      .eq('key', 'session_viewer_' + tokenHash)
      .maybeSingle();
    if (!data) return null;
    let session = null;
    try { session = JSON.parse(data.value); } catch { return null; }
    if (!session || session.role !== 'viewer' || !session.cabang || !session.hash) return null;
    if (session.hash !== tokenHash) return null;
    const expiresAt = new Date(session.expires);
    if (Number.isNaN(expiresAt.getTime()) || expiresAt < new Date()) return null;
    return { cabang: session.cabang, role: 'viewer' };
  } catch {
    return null;
  }
}

async function deleteSessionByKey(supabase, key) {
  if (!key) return;
  const { error } = await supabase
    .from('settings')
    .delete()
    .eq('key', key);
  if (error) throw error;
}

/**
 * Verify session token from X-Admin-Token header.
 * Token is hashed with SHA-256 and looked up in settings table.
 * @param {string[]} keys - allowed roles (e.g. ['admin'] or ['admin', 'dashboard'])
 */
async function requireAuth(req, res, keys = ['admin']) {
  const headerToken = String(req.headers['x-admin-token'] || '').trim();
  const cookieMatch = headerToken ? null : (readSessionCookies(req, keys)[0] || null);
  const token = headerToken || (cookieMatch && cookieMatch.token) || '';
  if (!token) {
    res.status(401).json({ error: 'Token diperlukan.' });
    return false;
  }
  try {
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const supabase = getSupabase();

    // Try session key for each allowed role (key: session_<role>_<hash>)
    let data = null;
    let sessionKey = '';
    for (const role of keys) {
      const currentSessionKey = 'session_' + role + '_' + tokenHash;
      const result = await supabase
        .from('settings')
        .select('value')
        .eq('key', currentSessionKey)
        .maybeSingle();
      if (result.data) {
        data = result.data;
        sessionKey = currentSessionKey;
        break;
      }
    }

    if (!data) {
      if (cookieMatch && cookieMatch.role) {
        clearSessionCookie(res, cookieMatch.role, req);
      }
      res.status(401).json({ error: 'Sesi tidak valid. Silakan login ulang.' });
      return false;
    }

    let session = null;
    try {
      session = JSON.parse(data.value);
    } catch {
      await deleteSessionByKey(supabase, sessionKey);
      if (cookieMatch && cookieMatch.role) {
        clearSessionCookie(res, cookieMatch.role, req);
      }
      res.status(401).json({ error: 'Sesi tidak valid. Silakan login ulang.' });
      return false;
    }

    const expiresAt = new Date(session && session.expires);
    if (!session || !session.hash || !session.role || Number.isNaN(expiresAt.getTime())) {
      await deleteSessionByKey(supabase, sessionKey);
      if (cookieMatch && cookieMatch.role) {
        clearSessionCookie(res, cookieMatch.role, req);
      }
      res.status(401).json({ error: 'Sesi tidak valid. Silakan login ulang.' });
      return false;
    }

    // Check hash matches
    if (session.hash !== tokenHash) {
      await deleteSessionByKey(supabase, sessionKey);
      if (cookieMatch && cookieMatch.role) {
        clearSessionCookie(res, cookieMatch.role, req);
      }
      res.status(401).json({ error: 'Token tidak valid.' });
      return false;
    }

    // Check expiry
    if (expiresAt < new Date()) {
      await deleteSessionByKey(supabase, sessionKey);
      if (cookieMatch && cookieMatch.role) {
        clearSessionCookie(res, session.role, req);
      }
      res.status(401).json({ error: 'Sesi kedaluwarsa. Silakan login ulang.' });
      return false;
    }

    // Check role
    if (!keys.includes(session.role)) {
      res.status(403).json({ error: 'Akses ditolak.' });
      return false;
    }

    return true;
  } catch (err) {
    console.error('Auth check error:', err.message);
    res.status(500).json({ error: 'Gagal verifikasi token.' });
    return false;
  }
}

// Shortcut: admin only
async function requireAdmin(req, res) {
  return requireAuth(req, res, ['admin']);
}

module.exports = { requireAuth, requireAdmin, getViewerSession };
