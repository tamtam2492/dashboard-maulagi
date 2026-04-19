const bcrypt = require('bcryptjs');
const { requireAdmin } = require('./_auth');
const { publishAdminWriteMarker } = require('./_admin-write-marker');
const { cors } = require('./_cors');
const { logError } = require('./_logger');
const { getSupabase } = require('./_supabase');
const { loginMaukirim, httpReq, ckStr, MK_HOST } = require('./_maukirim');

/**
 * Ambil daftar sub-akun dari Maukirim (/account/data/5).
 * Return array of { name: string, wa: string }
 */
async function fetchMaukirimSenders() {
  const ck = await loginMaukirim();
  const res = await httpReq({
    hostname: MK_HOST,
    path: '/account/data/5',
    method: 'GET',
    headers: { Cookie: ckStr(ck), 'User-Agent': 'Mozilla/5.0', Accept: 'text/html' },
  });
  if (res.status !== 200) throw new Error(`Maukirim /account/data/5 returned ${res.status}`);
  const cells = [...res.body.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)]
    .map((m) => m[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, '').trim());
  const senders = [];
  // Struktur tabel: No | Tanggal | Name | Whatsapp | Level | Action — skip 6 header
  for (let i = 6; i + 4 < cells.length; i += 6) {
    const name = cells[i + 2];
    const wa = cells[i + 3];
    if (name && wa && /^0[0-9]{7,14}$/.test(wa)) {
      senders.push({ name: name.trim().toUpperCase(), wa: wa.trim() });
    }
  }
  return senders;
}

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
        .select('id, nama, area, no_wa, viewer_pw_hash')
        .order('area', { ascending: true })
        .order('nama', { ascending: true });
      if (error) throw error;
      // Jangan expose viewer_pw_hash ke client, expose has_viewer + has_password saja
      const cabangWithStatus = (data || []).map((c) => ({
        id: c.id,
        nama: c.nama,
        area: c.area,
        no_wa: c.no_wa,
        has_viewer: !!(c.no_wa),
        has_password: !!(c.viewer_pw_hash),
      }));
      return res.json({ cabang: cabangWithStatus });
    } catch (err) {
      console.error(err);
      logError('cabang', err.message, { method: 'GET' });
      return res.status(500).json({ error: 'Gagal memuat data cabang.' });
    }
  }

  // POST /api/cabang — tambah cabang baru
  if (req.method === 'POST') {
    try {
      const { nama, area, no_wa, viewer_password } = req.body || {};
      if (!nama || typeof nama !== 'string' || !nama.trim()) {
        return res.status(400).json({ error: 'Nama cabang tidak boleh kosong.' });
      }
      const namaBersih = nama.trim().toUpperCase().slice(0, 100);
      const areaBersih = (area || '').trim().toUpperCase().slice(0, 50) || null;
      const noWaBersih = no_wa ? String(no_wa).replace(/\s+/g, '').slice(0, 20) : null;
      let viewerPwHash = undefined; // undefined = tidak diubah
      if (viewer_password && String(viewer_password).length > 0) {
        viewerPwHash = await bcrypt.hash(String(viewer_password), 12);
      }

      // Cek duplikat
      const { data: existing } = await supabase
        .from('cabang')
        .select('id')
        .eq('nama', namaBersih)
        .maybeSingle();
      if (existing) {
        return res.status(409).json({ error: 'Cabang sudah terdaftar.' });
      }

      // Cek duplikat no_wa
      if (noWaBersih) {
        const { data: existingWa } = await supabase
          .from('cabang').select('id').eq('no_wa', noWaBersih).maybeSingle();
        if (existingWa) return res.status(409).json({ error: 'Nomor WhatsApp sudah terdaftar di cabang lain.' });
      }

      const insertData = { nama: namaBersih, area: areaBersih };
      if (noWaBersih !== undefined) insertData.no_wa = noWaBersih;
      if (viewerPwHash !== undefined) insertData.viewer_pw_hash = viewerPwHash;

      const { data, error } = await supabase
        .from('cabang')
        .insert(insertData)
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
      const { id, nama, area, no_wa, viewer_password } = req.body || {};
      const idNum = parseInt(id, 10);
      if (!idNum) return res.status(400).json({ error: 'ID tidak valid.' });
      if (!nama || typeof nama !== 'string' || !nama.trim()) {
        return res.status(400).json({ error: 'Nama cabang tidak boleh kosong.' });
      }
      const namaBersih = nama.trim().toUpperCase().slice(0, 100);
      const areaBersih = (area || '').trim().toUpperCase().slice(0, 50) || null;
      // no_wa: null untuk hapus, string untuk set, undefined untuk tidak diubah
      const noWaBersih = no_wa === null ? null : (no_wa ? String(no_wa).replace(/\s+/g, '').slice(0, 20) : undefined);
      let viewerPwHash = undefined;
      if (viewer_password && String(viewer_password).length > 0) {
        viewerPwHash = await bcrypt.hash(String(viewer_password), 12);
      } else if (no_wa === null) {
        // Hapus WA berarti hapus password juga
        viewerPwHash = null;
      }

      // Cek duplikat (kecuali diri sendiri)
      const { data: existing } = await supabase
        .from('cabang')
        .select('id')
        .eq('nama', namaBersih)
        .neq('id', idNum)
        .maybeSingle();
      if (existing) return res.status(409).json({ error: 'Nama cabang sudah dipakai.' });

      // Cek duplikat no_wa (kecuali diri sendiri)
      if (noWaBersih !== undefined && noWaBersih !== null) {
        const { data: existingWa } = await supabase
          .from('cabang').select('id').eq('no_wa', noWaBersih).neq('id', idNum).maybeSingle();
        if (existingWa) return res.status(409).json({ error: 'Nomor WhatsApp sudah terdaftar di cabang lain.' });
      }

      const updateData = { nama: namaBersih, area: areaBersih };
      if (noWaBersih !== undefined) updateData.no_wa = noWaBersih;
      if (viewerPwHash !== undefined) updateData.viewer_pw_hash = viewerPwHash;

      const { data, error } = await supabase
        .from('cabang')
        .update(updateData)
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

  // POST /api/cabang?sync=maukirim — sync no_wa + viewer_pw_hash otomatis dari sub-akun Maukirim
  // Password viewer = nomor WA cabang (di-hash). Overwrite semua cabang yang namanya cocok.
  if (req.method === 'POST' && req.query.sync === 'maukirim') {
    try {
      const senders = await fetchMaukirimSenders();
      if (!senders.length) return res.status(502).json({ error: 'Tidak ada data sub-akun dari Maukirim.' });

      const { data: cabangList, error: fetchErr } = await supabase
        .from('cabang')
        .select('id, nama, no_wa, viewer_pw_hash');
      if (fetchErr) throw fetchErr;

      const senderMap = new Map(senders.map((s) => [s.name, s.wa]));

      let updated = 0;
      let skipped = 0;
      for (const cab of (cabangList || [])) {
        const namaNorm = (cab.nama || '').trim().toUpperCase();
        const wa = senderMap.get(namaNorm);
        if (!wa) { skipped++; continue; }
        // Selalu update no_wa; update hash hanya jika WA berubah atau belum punya password
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
        await publishCabangMarkerSafe(supabase, 'cabang_sync_maukirim', 'POST?sync=maukirim');
      }

      return res.json({
        success: true,
        updated,
        skipped,
        total_maukirim: senders.length,
        total_cabang: (cabangList || []).length,
      });
    } catch (err) {
      console.error(err);
      logError('cabang', err.message, { method: 'POST', action: 'sync_maukirim' });
      return res.status(500).json({ error: 'Sync dari Maukirim gagal: ' + err.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed.' });
};
