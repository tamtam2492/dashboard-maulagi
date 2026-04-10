const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { rateLimit } = require('./_ratelimit');
const { cors } = require('./_cors');
const { logError } = require('./_logger');

const authLimiter = rateLimit({ windowMs: 60 * 1000, max: 10 }); // 10 req/min per IP

function getSupabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
}

const PW_KEY = 'admin_password';
const ALLOWED_KEYS = ['admin_password', 'dashboard_password'];

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (cors(req, res, { methods: 'GET, POST, OPTIONS' })) return;

  // Rate limit POST (login/create/change)
  if (req.method === 'POST' && authLimiter(req, res)) return;

  const supabase = getSupabase();

  // GET /api/auth?key=... — cek apakah password sudah pernah dibuat
  if (req.method === 'GET') {
    try {
      const key = ALLOWED_KEYS.includes(req.query.key) ? req.query.key : PW_KEY;
      const { data } = await supabase
        .from('settings')
        .select('key')
        .eq('key', key)
        .maybeSingle();
      return res.json({ hasPassword: !!data, key });
    } catch (err) {
      console.error(err);
      logError('auth', err.message, { method: 'GET' });
      return res.status(500).json({ error: 'Gagal cek status password.' });
    }
  }

  // POST /api/auth — buat password baru (hanya jika belum ada) ATAU verifikasi login
  if (req.method === 'POST') {
    try {
      const { action, password, newPassword, key } = req.body || {};
      const pwKey = ALLOWED_KEYS.includes(key) ? key : PW_KEY;

      // action: 'create' — buat password pertama kali
      if (action === 'create') {
        if (!password || password.length < 8) {
          return res.status(400).json({ error: 'Password minimal 8 karakter.' });
        }
        // Pastikan belum ada
        const { data: existing } = await supabase
          .from('settings').select('key').eq('key', pwKey).maybeSingle();
        if (existing) {
          return res.status(409).json({ error: 'Password sudah ada. Gunakan fitur ganti password.' });
        }
        const hash = await bcrypt.hash(password, 12);
        const { error } = await supabase.from('settings')
          .upsert({ key: pwKey, value: hash });
        if (error) throw error;
        return res.json({ success: true, message: 'Password berhasil dibuat.' });
      }

      // action: 'verify' — cek login, return session token
      if (action === 'verify') {
        if (!password) return res.status(400).json({ error: 'Password diperlukan.' });
        const { data } = await supabase
          .from('settings').select('value').eq('key', pwKey).maybeSingle();
        if (!data) return res.status(404).json({ error: 'Password belum dibuat.' });
        const match = await bcrypt.compare(password, data.value);
        if (!match) return res.status(401).json({ error: 'Password salah.' });

        // Generate session token
        const sessionToken = crypto.randomBytes(32).toString('hex');
        const tokenHash = crypto.createHash('sha256').update(sessionToken).digest('hex');
        const role = pwKey === 'admin_password' ? 'admin' : 'dashboard';
        const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 60 min

        // Store session in settings (key: session_<role>_<full_hash>)
        await supabase.from('settings').upsert({
          key: 'session_' + role + '_' + tokenHash,
          value: JSON.stringify({ hash: tokenHash, role, expires: expiresAt }),
        });

        return res.json({ success: true, token: sessionToken, role });
      }

      // action: 'change' — ganti password
      if (action === 'change') {
        if (!password || !newPassword) {
          return res.status(400).json({ error: 'Password lama dan baru diperlukan.' });
        }
        if (newPassword.length < 8) {
          return res.status(400).json({ error: 'Password baru minimal 8 karakter.' });
        }
        const { data } = await supabase
          .from('settings').select('value').eq('key', pwKey).maybeSingle();
        if (!data) return res.status(404).json({ error: 'Password belum dibuat.' });
        const match = await bcrypt.compare(password, data.value);
        if (!match) return res.status(401).json({ error: 'Password lama salah.' });
        const hash = await bcrypt.hash(newPassword, 12);
        // Hapus semua session aktif untuk role ini agar token lama tidak bisa dipakai
        const sessionPrefix = pwKey === 'admin_password' ? 'session_admin_' : 'session_dashboard_';
        await supabase.from('settings').delete().like('key', sessionPrefix + '%');
        const { error } = await supabase.from('settings')
          .update({ value: hash }).eq('key', pwKey);
        if (error) throw error;
        return res.json({ success: true, message: 'Password berhasil diganti.' });
      }

      return res.status(400).json({ error: 'Action tidak valid.' });

    } catch (err) {
      console.error(err);
      logError('auth', err.message, { method: 'POST' });
      return res.status(500).json({ error: 'Terjadi kesalahan server.' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed.' });
};
