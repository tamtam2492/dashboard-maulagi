/**
 * Vercel Cron: sync nomor WA viewer cabang dari Maukirim secara otomatis.
 * Dipanggil oleh Vercel cron scheduler, bukan oleh user.
 * Protected: Authorization: Bearer CRON_SECRET
 */
const { syncCabangViewerFromSenders } = require('./_cabang-viewer-sync');
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

    const result = await syncCabangViewerFromSenders(supabase, senders);

    if (result.updated > 0) {
      await publishAdminWriteMarker(supabase, {
        source: 'cron_sync_maukirim',
        scopes: ['admin_cabang', 'audit'],
      });
    }

    return res.json({ success: true, ...result });
  } catch (err) {
    logError('cron', err.message, { action: 'sync_maukirim' });
    return res.status(500).json({ error: 'Cron sync gagal: ' + err.message });
  }
};
