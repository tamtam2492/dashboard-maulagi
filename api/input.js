const { Readable } = require('stream');
const { rateLimit } = require('./_ratelimit');
const { cors } = require('./_cors');
const { logError } = require('./_logger');
const { normalizeBankName } = require('./_bank');
const {
  buildProofSignaturePayload,
  formatProofDuplicateMessage,
  parseProofSignatureValue,
} = require('./_proof-signature');
const { getSupabase } = require('./_supabase');
const {
  getPeriodeFromDate,
  isPositiveTransferNominal,
  isValidTransferDate,
  normalizeTransferKet,
  parseTransferNominal,
} = require('./_transfer-utils');

const uploadLimiter = rateLimit({ windowMs: 60 * 1000, max: 5 }); // 5 uploads/min per IP

// Parse multipart/form-data tanpa dependency eksternal tambahan (pakai busboy)
const Busboy = require('busboy');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (cors(req, res, { methods: 'POST, OPTIONS' })) return;

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  // Rate limit uploads
  if (await uploadLimiter(req, res)) return;

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
    const { tgl_inputan, nama_bank, nama_cabang, nominal } = fields;
    if (!tgl_inputan || !nama_bank || !nama_cabang || !nominal) {
      return res.status(400).json({ error: 'Semua field wajib diisi.' });
    }
    if (!isPositiveTransferNominal(nominal)) {
      return res.status(400).json({ error: 'Nominal harus lebih dari 0.' });
    }
    if (!isValidTransferDate(tgl_inputan)) {
      return res.status(400).json({ error: 'Format tanggal tidak valid (YYYY-MM-DD).' });
    }
    const periode = getPeriodeFromDate(tgl_inputan);
    if (!periode) {
      return res.status(400).json({ error: 'Periode tidak dapat diturunkan dari tanggal input.' });
    }

    if (!fileBuffer || !fileName) {
      return res.status(400).json({ error: 'Bukti transfer wajib diupload.' });
    }

    const supabase = getSupabase();
    let buktiUrl = null;
    const normalizedCabang = String(nama_cabang || '').trim().toUpperCase();

    // Validasi nama_cabang terdaftar di tabel cabang
    const { data: cabangData } = await supabase
      .from('cabang')
      .select('id')
      .eq('nama', normalizedCabang)
      .maybeSingle();
    if (!cabangData) {
      return res.status(400).json({ error: 'Cabang tidak terdaftar.' });
    }

    const proofSignature = buildProofSignaturePayload({
      fileBuffer,
      fileName,
      mimeType: fileMime,
      namaCabang: normalizedCabang,
      tglInputan: tgl_inputan,
      namaBank: nama_bank,
      nominal,
    });

    if (!proofSignature.signature) {
      return res.status(400).json({ error: 'Bukti transfer tidak valid.' });
    }

    const { data: existingProofSetting, error: existingProofError } = await supabase
      .from('settings')
      .select('value')
      .eq('key', proofSignature.key)
      .maybeSingle();

    if (existingProofError) throw existingProofError;

    if (existingProofSetting && existingProofSetting.value) {
      const existingProof = parseProofSignatureValue(existingProofSetting.value);
      return res.status(409).json({
        error: formatProofDuplicateMessage(existingProof),
      });
    }

    // Upload foto jika ada
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

    const { error: uploadErr } = await supabase.storage
      .from('bukti-transfer')
      .upload(safeName, fileBuffer, { contentType: fileMime || 'image/jpeg' });

    if (uploadErr) throw uploadErr;

    // Simpan path saja (bukan signed URL yang akan expire)
    buktiUrl = safeName;

    // Insert ke tabel transfers
    const { data, error: insertErr } = await supabase.from('transfers').insert({
      timestamp: new Date().toISOString(),
      tgl_inputan,
      periode,
      nama_bank: normalizeBankName(nama_bank),
      nama_cabang: normalizedCabang,
      nominal: parseTransferNominal(nominal),
      ket: normalizeTransferKet(fields.ket),
      bukti_url: buktiUrl,
    }).select().single();

    if (insertErr) {
      if (buktiUrl) {
        await supabase.storage.from('bukti-transfer').remove([buktiUrl]).catch(() => {});
      }
      throw insertErr;
    }

    const proofRegistryValue = JSON.stringify({
      signature: proofSignature.signature,
      transferId: data.id,
      createdAt: data.timestamp || new Date().toISOString(),
      namaCabang: normalizedCabang,
      tglInputan: tgl_inputan,
      namaBank: normalizeBankName(nama_bank),
      nominal: parseTransferNominal(nominal),
      fileName,
      mimeType: fileMime || '',
    });

    const { error: proofRegistryError } = await supabase.from('settings').upsert({
      key: proofSignature.key,
      value: proofRegistryValue,
    });

    if (proofRegistryError) {
      await supabase.from('transfers').delete().eq('id', data.id).catch(() => {});
      if (buktiUrl) {
        await supabase.storage.from('bukti-transfer').remove([buktiUrl]).catch(() => {});
      }
      throw proofRegistryError;
    }

    return res.status(201).json({ success: true, id: data.id });

  } catch (err) {
    console.error(err);
    logError('input', err.message, { method: req.method });
    return res.status(500).json({ error: 'Gagal menyimpan data.' });
  }
};
