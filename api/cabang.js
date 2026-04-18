const { requireAdmin } = require('./_auth');
const { publishAdminWriteMarker } = require('./_admin-write-marker');
const { cors } = require('./_cors');
const { logError } = require('./_logger');
const { getSupabase } = require('./_supabase');

async function publishCabangMarkerSafe(supabase, source, context) {
  try {
    await publishAdminWriteMarker(supabase, {
      source,
      scopes: ['admin_cabang', 'audit'],
    });
  } catch (err) {
    logError('admin-marker', err.message, {
      method: context,
      action: 'publish_admin_write_marker',
      source,
      scopes: ['admin_cabang', 'audit'],
    });
  }
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (cors(req, res, { methods: 'GET, POST, PUT, DELETE, OPTIONS', headers: 'Content-Type, X-Admin-Token' })) return;

  // Write operations are admin only
  if (['POST', 'PUT', 'DELETE'].includes(req.method)) {
    if (!(await requireAdmin(req, res))) return;
  }

  const supabase = getSupabase();

  // GET /api/cabang — list semua cabang
  if (req.method === 'GET') {
    try {
      const { data, error } = await supabase
        .from('cabang')
        .select('id, nama, area')
        .order('area', { ascending: true })
        .order('nama', { ascending: true });
      if (error) throw error;
      return res.json({ cabang: data || [] });
    } catch (err) {
      console.error(err);
      logError('cabang', err.message, { method: 'GET' });
      return res.status(500).json({ error: 'Gagal memuat data cabang.' });
    }
  }

  // POST /api/cabang — tambah cabang baru
  if (req.method === 'POST') {
    try {
      const { nama, area } = req.body || {};
      if (!nama || typeof nama !== 'string' || !nama.trim()) {
        return res.status(400).json({ error: 'Nama cabang tidak boleh kosong.' });
      }
      const namaBersih = nama.trim().toUpperCase().slice(0, 100);
      const areaBersih = (area || '').trim().toUpperCase().slice(0, 50) || null;

      // Cek duplikat
      const { data: existing } = await supabase
        .from('cabang')
        .select('id')
        .eq('nama', namaBersih)
        .maybeSingle();
      if (existing) {
        return res.status(409).json({ error: 'Cabang sudah terdaftar.' });
      }

      const { data, error } = await supabase
        .from('cabang')
        .insert({ nama: namaBersih, area: areaBersih })
        .select()
        .single();
      if (error) throw error;
      await publishCabangMarkerSafe(supabase, 'cabang_create', 'POST');
      return res.status(201).json({ cabang: data });
    } catch (err) {
      console.error(err);
      logError('cabang', err.message, { method: 'POST' });
      return res.status(500).json({ error: 'Gagal menambah cabang.' });
    }
  }

  // PUT /api/cabang — edit nama/area cabang
  if (req.method === 'PUT') {
    try {
      const { id, nama, area } = req.body || {};
      const idNum = parseInt(id, 10);
      if (!idNum) return res.status(400).json({ error: 'ID tidak valid.' });
      if (!nama || typeof nama !== 'string' || !nama.trim()) {
        return res.status(400).json({ error: 'Nama cabang tidak boleh kosong.' });
      }
      const namaBersih = nama.trim().toUpperCase().slice(0, 100);
      const areaBersih = (area || '').trim().toUpperCase().slice(0, 50) || null;

      // Cek duplikat (kecuali diri sendiri)
      const { data: existing } = await supabase
        .from('cabang')
        .select('id')
        .eq('nama', namaBersih)
        .neq('id', idNum)
        .maybeSingle();
      if (existing) return res.status(409).json({ error: 'Nama cabang sudah dipakai.' });

      const { data, error } = await supabase
        .from('cabang')
        .update({ nama: namaBersih, area: areaBersih })
        .eq('id', idNum)
        .select()
        .single();
      if (error) throw error;
      await publishCabangMarkerSafe(supabase, 'cabang_update', 'PUT');
      return res.json({ cabang: data });
    } catch (err) {
      console.error(err);
      logError('cabang', err.message, { method: 'PUT' });
      return res.status(500).json({ error: 'Gagal mengubah cabang.' });
    }
  }

  // DELETE /api/cabang?id=xxx — hapus cabang
  if (req.method === 'DELETE') {
    try {
      const id = parseInt(req.query.id, 10);
      if (!id) return res.status(400).json({ error: 'ID tidak valid.' });

      // Ambil nama cabang untuk cek transfer
      const { data: cb, error: fetchErr } = await supabase.from('cabang').select('nama').eq('id', id).maybeSingle();
      if (fetchErr || !cb) return res.status(404).json({ error: 'Cabang tidak ditemukan.' });

      // Tolak hapus jika masih ada transfer
      const { count } = await supabase.from('transfers').select('id', { count: 'exact', head: true }).eq('nama_cabang', cb.nama);
      if (count > 0) {
        return res.status(409).json({ error: `Tidak dapat dihapus. Ada ${count} data transfer dengan cabang ini.` });
      }

      const { error } = await supabase.from('cabang').delete().eq('id', id);
      if (error) throw error;
      await publishCabangMarkerSafe(supabase, 'cabang_delete', 'DELETE');
      return res.json({ success: true });
    } catch (err) {
      console.error(err);
      logError('cabang', err.message, { method: 'DELETE' });
      return res.status(500).json({ error: 'Gagal menghapus cabang.' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed.' });
};
