const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./_auth');
const { cors } = require('./_cors');
const { logError } = require('./_logger');
const { normalizeBankName } = require('./_bank');

function getSupabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
}

function normalizeProofUrl(buktiUrl) {
  let value = String(buktiUrl || '').trim();
  if (!value) return '';
  if (value.includes('drive.google.com')) {
    let fileId = null;
    const byId = value.match(/[?&]id=([^&]+)/);
    const byPath = value.match(/\/file\/d\/([^/]+)/);
    if (byId) fileId = byId[1];
    else if (byPath) fileId = byPath[1];
    if (fileId) return '/api/proxy-image?id=' + fileId;
  }
  if (!value.startsWith('http')) {
    return '/api/proxy-image?path=' + encodeURIComponent(value);
  }
  return value;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (cors(req, res, { methods: 'GET, POST, PUT, DELETE, OPTIONS', headers: 'Content-Type, X-Admin-Token' })) return;

  // Transfer review and all write operations are admin only
  if (['GET', 'POST', 'PUT', 'DELETE'].includes(req.method)) {
    if (!(await requireAdmin(req, res))) return;
  }

  try {
  const supabase = getSupabase();

  // GET ?periode=2026-04
  if (req.method === 'GET') {
    const { periode } = req.query;
    if (!periode || !/^\d{4}-\d{2}$/.test(periode)) {
      return res.status(400).json({ error: 'Parameter periode tidak valid (format: YYYY-MM).' });
    }
    const [, mm] = periode.split('-');
    if (parseInt(mm) < 1 || parseInt(mm) > 12) {
      return res.status(400).json({ error: 'Bulan tidak valid.' });
    }
    const { data, error } = await supabase
      .from('transfers')
      .select('id, timestamp, tgl_inputan, periode, nama_bank, nama_cabang, nominal, bukti_url, ket')
      .eq('periode', periode)
      .order('timestamp', { ascending: true });

    if (error) return res.status(500).json({ error: error.message });

    const normalizedTransfers = (data || []).map(row => ({
      ...row,
      nama_bank: normalizeBankName(row.nama_bank),
      bukti: normalizeProofUrl(row.bukti_url),
    }));

    // Hitung summary
    const total = normalizedTransfers.reduce((s, r) => s + parseFloat(r.nominal || 0), 0);
    const cabangSet = new Set(normalizedTransfers.map(r => r.nama_cabang));
    return res.json({ transfers: normalizedTransfers, total, transaksi: normalizedTransfers.length, cabang: cabangSet.size });
  }

  // POST — split action
  if (req.method === 'POST') {
    const { action, id, rows } = req.body;

    if (action !== 'split') return res.status(400).json({ error: 'Action tidak dikenal.' });
    if (!id) return res.status(400).json({ error: 'ID transfer diperlukan.' });
    if (!Array.isArray(rows) || rows.length < 2) {
      return res.status(400).json({ error: 'Minimal 2 baris rincian untuk split.' });
    }

    // Ambil data asli
    const { data: orig, error: fetchErr } = await supabase
      .from('transfers')
      .select('*')
      .eq('id', id)
      .single();
    if (fetchErr || !orig) return res.status(404).json({ error: 'Transfer tidak ditemukan.' });

    // Validasi total rincian = nominal asli
    const totalRincian = rows.reduce((s, r) => s + (Math.round(parseFloat(r.nominal || 0))), 0);
    const origNominal = Math.round(parseFloat(orig.nominal));
    if (totalRincian !== origNominal) {
      return res.status(400).json({
        error: `Total rincian (${totalRincian}) tidak sama dengan nominal asli (${orig.nominal}).`
      });
    }

    // Validasi tiap baris
    for (const r of rows) {
      if (!r.tgl_inputan || !r.nominal || parseFloat(r.nominal) <= 0) {
        return res.status(400).json({ error: 'Setiap baris harus punya tanggal dan nominal > 0.' });
      }
    }

    // Hapus row asli dulu (lebih aman — jika delete gagal, data tidak terduplikat)
    const newRows = rows.map(r => ({
      timestamp: orig.timestamp,
      tgl_inputan: r.tgl_inputan,
      periode: orig.periode,
      nama_bank: normalizeBankName(orig.nama_bank),
      nama_cabang: orig.nama_cabang,
      nominal: Math.round(parseFloat(r.nominal)),
      bukti_url: orig.bukti_url,
      ket: r.ket?.trim() || orig.ket || null,
    }));

    const { error: delErr } = await supabase.from('transfers').delete().eq('id', id);
    if (delErr) return res.status(500).json({ error: 'Gagal menghapus transfer asli: ' + delErr.message });

    // Insert baris baru
    const { error: insErr } = await supabase.from('transfers').insert(newRows);
    if (insErr) {
      // Rollback: restore row asli jika insert gagal
      const { timestamp, tgl_inputan: ti, periode: p, nama_bank: nb, nama_cabang: nc, nominal: n, bukti_url: bu, ket: k } = orig;
      await supabase.from('transfers').insert({ timestamp, tgl_inputan: ti, periode: p, nama_bank: normalizeBankName(nb), nama_cabang: nc, nominal: n, bukti_url: bu, ket: k }).catch(() => {});
      return res.status(500).json({ error: 'Gagal insert baris baru, data asli dikembalikan.' });
    }

    return res.json({ success: true, inserted: newRows.length });
  }

  // PUT — edit tgl_inputan (dan optional ket) satu baris
  if (req.method === 'PUT') {
    const { id, tgl_inputan, ket } = req.body || {};
    if (!id) return res.status(400).json({ error: 'ID diperlukan.' });
    if (!tgl_inputan || !/^\d{4}-\d{2}-\d{2}$/.test(tgl_inputan)) {
      return res.status(400).json({ error: 'Format tanggal tidak valid (YYYY-MM-DD).' });
    }
    const update = { tgl_inputan };
    if (ket !== undefined) update.ket = ket?.trim() || null;

    const { error: updErr } = await supabase.from('transfers').update(update).eq('id', id);
    if (updErr) return res.status(500).json({ error: updErr.message });
    return res.json({ success: true });
  }

  // DELETE — hapus satu baris transfer
  if (req.method === 'DELETE') {
    const id = String(req.query.id || req.body?.id || '').trim();
    if (!id) return res.status(400).json({ error: 'ID diperlukan.' });

    const { data: existing, error: findErr } = await supabase
      .from('transfers')
      .select('id, nama_cabang, tgl_inputan, nominal')
      .eq('id', id)
      .maybeSingle();
    if (findErr) return res.status(500).json({ error: findErr.message });
    if (!existing) return res.status(404).json({ error: 'Transfer tidak ditemukan.' });

    const { error: delErr } = await supabase.from('transfers').delete().eq('id', id);
    if (delErr) return res.status(500).json({ error: delErr.message });

    return res.json({ success: true, deleted: existing });
  }

  return res.status(405).json({ error: 'Method not allowed.' });
  } catch (err) {
    console.error(err);
    logError('transfer', err.message, { method: req.method });
    return res.status(500).json({ error: 'Terjadi kesalahan server.' });
  }
};
