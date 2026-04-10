const { createClient } = require('@supabase/supabase-js');
const { Readable } = require('stream');
const { rateLimit } = require('./_ratelimit');
const { cors } = require('./_cors');
const { logError } = require('./_logger');
const { normalizeBankName } = require('./_bank');

const uploadLimiter = rateLimit({ windowMs: 60 * 1000, max: 5 }); // 5 uploads/min per IP

function getSupabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
}

// Parse multipart/form-data tanpa dependency eksternal tambahan (pakai busboy)
const Busboy = require('busboy');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (cors(req, res, { methods: 'POST, OPTIONS' })) return;

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  // Rate limit uploads
  if (uploadLimiter(req, res)) return;

  try {
    const fields = {};
    let fileBuffer = null;
    let fileName = null;
    let fileMime = null;

    await new Promise((resolve, reject) => {
      const busboy = Busboy({ headers: req.headers });

      busboy.on('field', (name, val) => {
        fields[name] = val;
      });

      const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB
      busboy.on('file', (name, file, info) => {
        const { filename, mimeType } = info;
        fileName = filename;
        fileMime = mimeType;
        const chunks = [];
        let totalSize = 0;
        file.on('data', d => {
          totalSize += d.length;
          if (totalSize > MAX_FILE_SIZE) {
            file.destroy(new Error('File terlalu besar. Maksimal 5MB.'));
            return;
          }
          chunks.push(d);
        });
        file.on('end', () => { fileBuffer = Buffer.concat(chunks); });
      });

      busboy.on('finish', resolve);
      busboy.on('error', reject);

      if (req.pipe) {
        req.pipe(busboy);
      } else {
        // Vercel mungkin sudah parse body — tangani keduanya
        const stream = Readable.from(req);
        stream.pipe(busboy);
      }
    });

    // Validasi fields
    const { tgl_inputan, nama_bank, nama_cabang, nominal, periode } = fields;
    if (!tgl_inputan || !nama_bank || !nama_cabang || !nominal || !periode) {
      return res.status(400).json({ error: 'Semua field wajib diisi.' });
    }
    if (parseFloat(nominal) <= 0 || isNaN(parseFloat(nominal))) {
      return res.status(400).json({ error: 'Nominal harus lebih dari 0.' });
    }
    if (!/^\d{4}-\d{2}$/.test(periode)) {
      return res.status(400).json({ error: 'Format periode tidak valid (YYYY-MM).' });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(tgl_inputan)) {
      return res.status(400).json({ error: 'Format tanggal tidak valid (YYYY-MM-DD).' });
    }

    const supabase = getSupabase();
    let buktiUrl = null;

    // Validasi nama_cabang terdaftar di tabel cabang
    const { data: cabangData } = await supabase
      .from('cabang')
      .select('id')
      .eq('nama', nama_cabang.trim().toUpperCase())
      .maybeSingle();
    if (!cabangData) {
      return res.status(400).json({ error: 'Cabang tidak terdaftar.' });
    }

    // Upload foto jika ada
    if (fileBuffer && fileName) {
      const ext = fileName.split('.').pop().toLowerCase();
      const allowedExt = ['jpg', 'jpeg', 'png', 'webp', 'gif'];
      const allowedMime = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
      if (!allowedExt.includes(ext) || (fileMime && !allowedMime.includes(fileMime))) {
        return res.status(400).json({ error: 'Format file tidak didukung. Gunakan JPG/PNG.' });
      }
      if (fileBuffer.length > 5 * 1024 * 1024) {
        return res.status(400).json({ error: 'File terlalu besar. Maksimal 5MB.' });
      }
      const safeName = `${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;

      const { data: uploadData, error: uploadErr } = await supabase.storage
        .from('bukti-transfer')
        .upload(safeName, fileBuffer, { contentType: fileMime || 'image/jpeg' });

      if (uploadErr) throw uploadErr;

      // Simpan path saja (bukan signed URL yang akan expire)
      buktiUrl = safeName;
    }

    // Insert ke tabel transfers
    const { data, error: insertErr } = await supabase.from('transfers').insert({
      timestamp: new Date().toISOString(),
      tgl_inputan,
      periode,
      nama_bank: normalizeBankName(nama_bank),
      nama_cabang: nama_cabang.trim().toUpperCase(),
      nominal: parseFloat(nominal),
      ket: fields.ket?.trim() || null,
      bukti_url: buktiUrl,
    }).select().single();

    if (insertErr) throw insertErr;

    return res.status(201).json({ success: true, id: data.id });

  } catch (err) {
    console.error(err);
    logError('input', err.message, { method: req.method });
    return res.status(500).json({ error: 'Gagal menyimpan data.' });
  }
};
