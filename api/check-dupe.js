const { cors } = require('./_cors');
const { logError } = require('./_logger');
const { rateLimit } = require('./_ratelimit');
const { normalizeBankName } = require('./_bank');
const { getSupabase } = require('./_supabase');

const dupeLimiter = rateLimit({ windowMs: 60 * 1000, max: 20 }); // 20 req/min per IP

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (cors(req, res, { methods: 'POST, OPTIONS' })) return;

  if (await dupeLimiter(req, res)) return;

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  try {
    const { nama_cabang, tgl_inputan, nominal } = req.body || {};

    if (!nama_cabang || !tgl_inputan || !nominal) {
      return res.status(400).json({ error: 'Field tidak lengkap.' });
    }

    const supabase = getSupabase();

    const { data, error } = await supabase
      .from('transfers')
      .select('id, timestamp, tgl_inputan, nama_bank, nominal, periode')
      .eq('nama_cabang', String(nama_cabang).trim().toUpperCase())
      .eq('tgl_inputan', String(tgl_inputan).trim())
      .eq('nominal', parseFloat(nominal))
      .order('timestamp', { ascending: false })
      .limit(5);

    if (error) throw error;

    return res.status(200).json({
      dupes: (data || []).map(row => ({
        ...row,
        nama_bank: normalizeBankName(row.nama_bank),
      }))
    });
  } catch (err) {
    console.error(err);
    logError('check-dupe', err.message, { method: 'POST' });
    return res.status(500).json({ error: 'Gagal cek duplikat.' });
  }
};
