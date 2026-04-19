const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { rateLimit } = require('./_ratelimit');
const { cors } = require('./_cors');
const { logError } = require('./_logger');
const { requireAdmin, requireAuth, getViewerSession } = require('./_auth');
const { sendOpsNotification, shouldNotifySource } = require('./_ops-notifier');
const {
  normalizeBoundedInt,
  normalizeQueryFlag,
  normalizeText,
} = require('./_request-validation');
const { normalizeViewerWa } = require('./_cabang-viewer-sync');
const { loginMaukirimWithCredentials } = require('./_maukirim');
const { getSupabase } = require('./_supabase');
const { clearAllSessionCookies, clearSessionCookie, readSessionCookies, setSessionCookie } = require('./_session-cookie');

const authLimiter = rateLimit({ windowMs: 60 * 1000, max: 10, bucket: 'auth-write' }); // 10 req/min per IP
const notifyTestLimiter = rateLimit({ windowMs: 60 * 1000, max: 5, bucket: 'auth-notify-test' });
const AUTH_SLOW_TIMEOUT_MS = Number(process.env.AUTH_SLOW_TIMEOUT_MS || 10000) || 10000;
const DEFAULT_SESSION_MAX_AGE_SECONDS = 60 * 60;
const REMEMBERED_SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

const PW_KEY = 'admin_password';
const ALLOWED_KEYS = ['admin_password', 'dashboard_password'];

function timingSafeSecretEqual(left, right) {
  const normalizedLeft = Buffer.from(String(left || '').trim());
  const normalizedRight = Buffer.from(String(right || '').trim());
  if (!normalizedLeft.length || !normalizedRight.length) return false;
  if (normalizedLeft.length !== normalizedRight.length) return false;
  return crypto.timingSafeEqual(normalizedLeft, normalizedRight);
}

function shouldRememberSession(rawValue) {
  return rawValue === true
    || rawValue === 1
    || rawValue === '1'
    || String(rawValue || '').trim().toLowerCase() === 'true';
}

function getSessionMaxAgeSeconds(remember) {
  return shouldRememberSession(remember)
    ? REMEMBERED_SESSION_MAX_AGE_SECONDS
    : DEFAULT_SESSION_MAX_AGE_SECONDS;
}

function createAuthSlowWatch(message, meta = {}, options = {}) {
  const timeoutMs = Number(options.timeoutMs || AUTH_SLOW_TIMEOUT_MS) || AUTH_SLOW_TIMEOUT_MS;
  const logFn = typeof options.logFn === 'function' ? options.logFn : logError;
  const setTimer = typeof options.setTimer === 'function' ? options.setTimer : setTimeout;
  const clearTimer = typeof options.clearTimer === 'function' ? options.clearTimer : clearTimeout;
  let fired = false;

  const timerId = setTimer(() => {
    fired = true;
    logFn('auth', message, {
      method: meta.method,
      action: meta.action,
      role: meta.role,
      key: meta.key,
      path: '/api/auth',
      slowMs: timeoutMs,
    });
  }, timeoutMs);

  return {
    stop() {
      clearTimer(timerId);
    },
    didFire() {
      return fired;
    },
  };
}

async function withAuthSlowWatch(message, meta, task) {
  const watch = createAuthSlowWatch(message, meta);
  try {
    return await task();
  } finally {
    watch.stop();
  }
}

function isNotifyTestRequest(req) {
  return req.method === 'POST' && (
    normalizeQueryFlag(req.query?.notify_test)
    || String(req.body?.action || '').trim() === 'notify_test'
  );
}

async function authorizeNotifyTestRequest(req, res) {
  const expectedSecret = String(process.env.TELEGRAM_NOTIFY_SECRET || '').trim();
  const providedSecret = String(req.headers['x-ops-secret'] || '').trim();

  if (!expectedSecret) {
    res.status(503).json({ error: 'Notifier secret belum dikonfigurasi.' });
    return false;
  }

  if (!providedSecret) {
    res.status(401).json({ error: 'Unauthorized.' });
    return false;
  }

  if (timingSafeSecretEqual(providedSecret, expectedSecret)) return true;
  res.status(401).json({ error: 'Unauthorized.' });
  return false;
}

async function handleNotifyTest(req, res) {
  if (await notifyTestLimiter(req, res)) return;

  const authorized = await authorizeNotifyTestRequest(req, res);
  if (!authorized) return;

  const source = String(req.body?.source || 'dashboard').trim().toLowerCase();
  if (!shouldNotifySource(source)) {
    return res.status(409).json({
      error: 'Source belum aktif di TELEGRAM_NOTIFY_SOURCES.',
      source,
    });
  }

  const title = String(req.body?.title || 'Ops notifier test').trim().slice(0, 140) || 'Ops notifier test';
  const message = String(req.body?.message || 'Tes manual dari Vercel API ke Lambda Telegram berhasil.').trim().slice(0, 1200);
  if (!message) {
    return res.status(400).json({ error: 'Message wajib diisi.' });
  }

  const result = await sendOpsNotification({
    source,
    eventType: 'manual_test',
    severity: 'info',
    title,
    message,
    meta: {
      trigger: 'logs-notify-test',
      path: '/api/auth?ops=logs&notify_test=1',
      requestedAt: new Date().toISOString(),
    },
  });

  if (result.skipped) {
    return res.status(409).json({
      error: 'Notifier tidak aktif.',
      reason: result.reason || 'skipped',
    });
  }

  if (!result.ok) {
    return res.status(502).json({
      error: 'Notifier gagal meneruskan ke Lambda.',
      status: result.status || 0,
    });
  }

  return res.status(200).json({
    success: true,
    source,
    status: result.status || 200,
  });
}

async function handleLogsRoute(req, res) {
  if (isNotifyTestRequest(req)) {
    return handleNotifyTest(req, res);
  }

  if (!(await requireAdmin(req, res))) return;

  const supabase = getSupabase();

  if (req.method === 'GET') {
    try {
      const limit = normalizeBoundedInt(req.query.limit, { fallback: 100, min: 1, max: 500 });
      const { data, error } = await supabase
        .from('error_logs')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(limit);
      if (error) throw error;
      return res.json(data || []);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  if (req.method === 'DELETE') {
    try {
      const { error } = await supabase.from('error_logs').delete().gte('id', 0);
      if (error) throw error;
      return res.json({ success: true });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed.' });
}

async function deleteSessionByHash(supabase, role, tokenHash) {
  const { error } = await supabase
    .from('settings')
    .delete()
    .eq('key', 'session_' + role + '_' + tokenHash);
  if (error) throw error;
}

async function verifyViewerCabangAccess(supabase, noWa, viewerPassword, options = {}) {
  const loginFn = typeof options.loginFn === 'function'
    ? options.loginFn
    : loginMaukirimWithCredentials;
  const normalizedNoWa = normalizeViewerWa(noWa);

  const { data: cabang, error } = await supabase
    .from('cabang')
    .select('id, nama, no_wa')
    .eq('no_wa', normalizedNoWa)
    .maybeSingle();
  if (error) throw error;
  if (!cabang) return null;

  await loginFn(normalizedNoWa, viewerPassword);
  return cabang;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (cors(req, res, { methods: 'GET, POST, DELETE, OPTIONS', headers: 'Content-Type, X-Admin-Token, X-Ops-Secret' })) return;

  if (normalizeText(req.query.ops, 40) === 'logs') {
    return handleLogsRoute(req, res);
  }

  // Rate limit POST (login/create/change)
  if (req.method === 'POST' && await authLimiter(req, res)) return;

  // GET /api/auth?key=... — cek apakah password sudah pernah dibuat
  if (req.method === 'GET') {
    try {
      if (normalizeQueryFlag(req.query.session)) {
        const rawRole = normalizeText(req.query.role, 20);
        if (rawRole === 'viewer') {
          const vs = await getViewerSession(req);
          if (!vs) return res.status(401).json({ error: 'Sesi tidak valid.' });
          return res.json({ authenticated: true, role: 'viewer', cabang: vs.cabang });
        }
        const requestedRole = rawRole === 'admin' ? 'admin' : 'dashboard';
        return withAuthSlowWatch('Pemeriksaan sesi login lambat lebih dari 10 detik.', {
          method: 'GET',
          action: 'session_check',
          role: requestedRole,
        }, async () => {
          const authorized = await requireAuth(req, res, [requestedRole]);
          if (!authorized) return;
          return res.json({ authenticated: true, role: requestedRole });
        });
      }

      const supabase = getSupabase();
      const requestedKey = normalizeText(req.query.key, 40);
      const key = ALLOWED_KEYS.includes(requestedKey) ? requestedKey : PW_KEY;
      return withAuthSlowWatch('Pemeriksaan status password lambat lebih dari 10 detik.', {
        method: 'GET',
        action: 'password_status',
        key,
      }, async () => {
        const { data } = await supabase
          .from('settings')
          .select('key')
          .eq('key', key)
          .maybeSingle();
        return res.json({ hasPassword: !!data, key });
      });
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
      const supabase = getSupabase();

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

      // action: 'verify_viewer' — login dengan no_wa + password Maukirim cabang
      if (action === 'verify_viewer') {
        const noWa = normalizeViewerWa(req.body.no_wa);
        const viewerPw = String(req.body.password || '');
        const sessionMaxAgeSeconds = getSessionMaxAgeSeconds(req.body.remember);
        if (!noWa) return res.status(400).json({ error: 'Nomor WhatsApp diperlukan.' });
        if (!viewerPw) return res.status(400).json({ error: 'Password diperlukan.' });
        return withAuthSlowWatch('Verifikasi login viewer lambat lebih dari 10 detik.', {
          method: 'POST', action: 'verify_viewer',
        }, async () => {
          let cb = null;
          try {
            cb = await verifyViewerCabangAccess(supabase, noWa, viewerPw);
          } catch (err) {
            if (err && err.code === 'MAUKIRIM_AUTH_FAILED') {
              return res.status(401).json({ error: 'Nomor WhatsApp atau password salah.' });
            }
            if (err && err.code === 'MAUKIRIM_UPSTREAM_ERROR') {
              return res.status(502).json({ error: 'Verifikasi ke Maukirim sedang bermasalah. Coba lagi.' });
            }
            throw err;
          }

          if (!cb) {
            return res.status(401).json({ error: 'Nomor WhatsApp atau password salah.' });
          }

          const sessionToken = crypto.randomBytes(32).toString('hex');
          const tokenHash = crypto.createHash('sha256').update(sessionToken).digest('hex');
          const expiresAt = new Date(Date.now() + sessionMaxAgeSeconds * 1000).toISOString();
          await supabase.from('settings').upsert({
            key: 'session_viewer_' + tokenHash,
            value: JSON.stringify({ hash: tokenHash, role: 'viewer', cabang: cb.nama, expires: expiresAt }),
          });
          setSessionCookie(res, 'viewer', sessionToken, req, sessionMaxAgeSeconds);
          return res.json({ success: true, token: sessionToken, role: 'viewer', cabang: cb.nama });
        });
      }

      // action: 'verify' — cek login, return session token
      if (action === 'verify') {
        if (!password) return res.status(400).json({ error: 'Password diperlukan.' });
        const sessionMaxAgeSeconds = getSessionMaxAgeSeconds(req.body.remember);
        return withAuthSlowWatch('Verifikasi login lambat lebih dari 10 detik.', {
          method: 'POST',
          action: 'verify',
          key: pwKey,
          role: pwKey === 'admin_password' ? 'admin' : 'dashboard',
        }, async () => {
          const { data } = await supabase
            .from('settings').select('value').eq('key', pwKey).maybeSingle();
          if (!data) return res.status(404).json({ error: 'Password belum dibuat.' });
          const match = await bcrypt.compare(password, data.value);
          if (!match) return res.status(401).json({ error: 'Password salah.' });

          // Generate session token
          const sessionToken = crypto.randomBytes(32).toString('hex');
          const tokenHash = crypto.createHash('sha256').update(sessionToken).digest('hex');
          const role = pwKey === 'admin_password' ? 'admin' : 'dashboard';
          const expiresAt = new Date(Date.now() + sessionMaxAgeSeconds * 1000).toISOString();

          // Store session in settings (key: session_<role>_<full_hash>)
          await supabase.from('settings').upsert({
            key: 'session_' + role + '_' + tokenHash,
            value: JSON.stringify({ hash: tokenHash, role, expires: expiresAt }),
          });

          setSessionCookie(res, role, sessionToken, req, sessionMaxAgeSeconds);

          return res.json({ success: true, token: sessionToken, role });
        });
      }

      if (action === 'logout') {
        const headerToken = String(req.headers['x-admin-token'] || '').trim();
        const cookieTokens = readSessionCookies(req, ['admin', 'dashboard', 'viewer']).map((entry) => entry.token);
        const tokens = [...new Set([headerToken, ...cookieTokens].filter(Boolean))];

        for (const rawToken of tokens) {
          const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
          await deleteSessionByHash(supabase, 'admin', tokenHash);
          await deleteSessionByHash(supabase, 'dashboard', tokenHash);
          await deleteSessionByHash(supabase, 'viewer', tokenHash);
        }

        clearAllSessionCookies(res, req);
        return res.json({ success: true, message: 'Logout berhasil.' });
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
        clearSessionCookie(res, pwKey === 'admin_password' ? 'admin' : 'dashboard', req);
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

module.exports.timingSafeSecretEqual = timingSafeSecretEqual;
module.exports.createAuthSlowWatch = createAuthSlowWatch;
module.exports.shouldRememberSession = shouldRememberSession;
module.exports.getSessionMaxAgeSeconds = getSessionMaxAgeSeconds;
module.exports.verifyViewerCabangAccess = verifyViewerCabangAccess;
