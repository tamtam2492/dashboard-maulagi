const { createClient } = require('@supabase/supabase-js');

let cachedClient = null;
let cachedKey = null;

function getSupabaseKey() {
  return (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
}

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = getSupabaseKey();

  if (!url || !key) {
    throw new Error('SUPABASE_URL dan SUPABASE_SERVICE_ROLE_KEY wajib diisi.');
  }

  if (!cachedClient || cachedKey !== key) {
    cachedClient = createClient(url, key, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });
    cachedKey = key;
  }

  return cachedClient;
}

module.exports = { getSupabase };