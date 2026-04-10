const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./_auth');
const { cors } = require('./_cors');

function getSupabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (cors(req, res, { methods: 'GET, DELETE, OPTIONS', headers: 'Content-Type, X-Admin-Token' })) return;

  if (!(await requireAdmin(req, res))) return;

  const supabase = getSupabase();

  // GET /api/logs?limit=100 — ambil log terbaru
  if (req.method === 'GET') {
    try {
      const limit = Math.min(parseInt(req.query.limit) || 100, 500);
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

  // DELETE /api/logs — hapus semua log
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
};
