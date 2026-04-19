/**
 * Vercel Cron: sync WA + password cabang dari Maukirim secara otomatis.
 * Dipanggil oleh Vercel cron scheduler, bukan oleh user.
 * Protected: Authorization: Bearer CRON_SECRET
 */
const bcrypt = require('bcryptjs');
const { getSupabase } = require('./_supabase');
const { fetchMaukirimSenders } = require('./_maukirim');
const { publishAdminWriteMarker } = require('./_admin-write-marker');
const { logError } = require('./_logger');

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed.' });

  const secret = process.env.CRON_SECRET;
  const auth = req.headers['authorization'] || '';
  if (!secret || auth !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'Unauthorized.' });
  }

  try {
    const supabase = getSupabase();
    const senders = await fetchMaukirimSenders();
    if (!senders.length) return res.json({ success: true, updated: 0, message: 'No senders from Maukirim.' });

    const { data: cabangList, error } = await supabase
      .from('cabang')
      .select('id, nama, no_wa, viewer_pw_hash');
    if (error) throw error;

    const senderMap = new Map(senders.map((s) => [s.name, s.wa]));
    let updated = 0;
    let skipped = 0;

    for (const cab of (cabangList || [])) {
      const wa = senderMap.get((cab.nama || '').trim().toUpperCase());
      if (!wa) { skipped++; continue; }
      const waChanged = cab.no_wa !== wa;
      const noPassword = !cab.viewer_pw_hash;
      const updateData = { no_wa: wa };
      if (waChanged || noPassword) {
        updateData.viewer_pw_hash = await bcrypt.hash(wa, 10);
      }
      await supabase.from('cabang').update(updateData).eq('id', cab.id);
      updated++;
    }

    if (updated > 0) {
      await publishAdminWriteMarker(supabase, {
        source: 'cron_sync_maukirim',
        scopes: ['admin_cabang', 'audit'],
      });
    }

    return res.json({ success: true, updated, skipped, total: (cabangList || []).length });
  } catch (err) {
    logError('cron', err.message, { action: 'sync_maukirim' });
    return res.status(500).json({ error: 'Cron sync gagal: ' + err.message });
  }
};
