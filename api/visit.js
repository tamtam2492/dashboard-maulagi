const { cors } = require('./_cors');
const { logError } = require('./_logger');
const { getSupabase } = require('./_supabase');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (cors(req, res)) return;

  try {
    const visitorId = (req.query.vid || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
    if (!visitorId) return res.json({ today: 0 });

    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Makassar' });
    const supabase = getSupabase();

    // Cek apakah visitor ini sudah tercatat hari ini
    const { data: existing } = await supabase
      .from('visitors')
      .select('id')
      .eq('tgl', today)
      .eq('visitor_id', visitorId)
      .maybeSingle();

    if (!existing) {
      await supabase.from('visitors').insert({ tgl: today, visitor_id: visitorId });
    }

    // Hitung unique visitors hari ini
    const { data: todayRows } = await supabase
      .from('visitors')
      .select('visitor_id')
      .eq('tgl', today);

    const uniqueCount = new Set((todayRows || []).map(r => r.visitor_id)).size;
    return res.json({ today: uniqueCount });

  } catch (err) {
    logError('visit', err.message, { method: req.method });
    console.error(err);
    return res.status(500).json({ today: 0 });
  }
};
