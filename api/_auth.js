const crypto = require('crypto');
const { getSupabase } = require('./_supabase');

/**
 * Verify session token from X-Admin-Token header.
 * Token is hashed with SHA-256 and looked up in settings table.
 * @param {string[]} keys - allowed roles (e.g. ['admin'] or ['admin', 'dashboard'])
 */
async function requireAuth(req, res, keys = ['admin']) {
  const token = req.headers['x-admin-token'];
  if (!token) {
    res.status(401).json({ error: 'Token diperlukan.' });
    return false;
  }
  try {
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const supabase = getSupabase();

    // Try session key for each allowed role (key: session_<role>_<hash>)
    let data = null;
    for (const role of keys) {
      const result = await supabase
        .from('settings')
        .select('value')
        .eq('key', 'session_' + role + '_' + tokenHash)
        .maybeSingle();
      if (result.data) { data = result.data; break; }
    }

    if (!data) {
      res.status(401).json({ error: 'Sesi tidak valid. Silakan login ulang.' });
      return false;
    }

    const session = JSON.parse(data.value);

    // Check hash matches
    if (session.hash !== tokenHash) {
      res.status(401).json({ error: 'Token tidak valid.' });
      return false;
    }

    // Check expiry
    if (new Date(session.expires) < new Date()) {
      await supabase.from('settings').delete().eq('key', 'session_' + session.role + '_' + tokenHash);
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

module.exports = { requireAuth, requireAdmin };
