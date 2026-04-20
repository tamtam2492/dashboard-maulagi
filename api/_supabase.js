const { createClient } = require('@supabase/supabase-js');

let cachedClient = null;
let cachedKey = null;
let cachedUrl = null;

const SUPABASE_SECRET_PREFIX = 'sb_secret_';

function safeBase64UrlDecode(value) {
  const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
  return Buffer.from(padded, 'base64').toString('utf8');
}

function parseSupabaseJwtPayload(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;

  try {
    return JSON.parse(safeBase64UrlDecode(parts[1] || ''));
  } catch {
    return null;
  }
}

function getSupabaseKeyIssue(key) {
  const normalizedKey = String(key || '').trim();
  if (!normalizedKey) {
    return 'SUPABASE_URL dan SUPABASE_SERVICE_ROLE_KEY wajib diisi.';
  }
  if (normalizedKey.startsWith(SUPABASE_SECRET_PREFIX)) {
    return null;
  }

  const payload = parseSupabaseJwtPayload(normalizedKey);
  if (!payload) {
    return 'SUPABASE_SERVICE_ROLE_KEY format tidak valid. Harapkan sb_secret_* atau JWT legacy Supabase role service_role.';
  }

  const issuer = String(payload.iss || '').trim();
  if (issuer && issuer !== 'supabase') {
    return `SUPABASE_SERVICE_ROLE_KEY issuer JWT tidak valid: ${issuer}`;
  }

  const role = String(payload.role || '').trim();
  if (role !== 'service_role') {
    return `SUPABASE_SERVICE_ROLE_KEY tidak valid untuk backend: role ${role || 'unknown'}.`;
  }

  return null;
}

function getSupabaseKey() {
  return (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
}

function getSupabase() {
  const url = String(process.env.SUPABASE_URL || '').trim();
  const key = getSupabaseKey();

  if (!url || !key) {
    throw new Error('SUPABASE_URL dan SUPABASE_SERVICE_ROLE_KEY wajib diisi.');
  }

  const keyIssue = getSupabaseKeyIssue(key);
  if (keyIssue) {
    throw new Error(keyIssue);
  }

  if (!cachedClient || cachedKey !== key || cachedUrl !== url) {
    cachedClient = createClient(url, key, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });
    cachedKey = key;
    cachedUrl = url;
  }

  return cachedClient;
}

module.exports = {
  getSupabase,
  getSupabaseKeyIssue,
  parseSupabaseJwtPayload,
};