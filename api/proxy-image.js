const { cors } = require('./_cors');
const { rateLimit } = require('./_ratelimit');
const { ensureAllowedMethod, normalizeText } = require('./_request-validation');
const { getSupabase } = require('./_supabase');

const limiter = rateLimit({ windowMs: 60 * 1000, max: 300 });
const IMAGE_FETCH_TIMEOUT_MS = 10000;

async function fetchWithTimeout(url, options = {}) {
  const timeoutSignal = AbortSignal.timeout(IMAGE_FETCH_TIMEOUT_MS);
  return fetch(url, {
    ...options,
    signal: timeoutSignal,
  });
}

module.exports = async (req, res) => {
  if (cors(req, res, { methods: 'GET, OPTIONS' })) return;
  if (!ensureAllowedMethod(req, res, 'GET')) return;
  if (await limiter(req, res)) return;

  const id = normalizeText(req.query && req.query.id, 240);
  const path = normalizeText(req.query && req.query.path, 240);

  // --- Mode 1: Supabase storage path → proxy image bytes ---
  if (path) {
    if (!/^[a-zA-Z0-9_\-.]{5,200}$/.test(path)) {
      return res.status(400).json({ error: 'Path tidak valid.' });
    }
    try {
      const supabase = getSupabase();
      const { data, error } = await supabase.storage
        .from('bukti-transfer')
        .createSignedUrl(path, 300);
      if (error || !data?.signedUrl) {
        return res.status(404).json({ error: 'Gambar tidak ditemukan.' });
      }
      const imgRes = await fetchWithTimeout(data.signedUrl);
      if (!imgRes.ok) {
        return res.status(404).json({ error: 'Gambar tidak ditemukan.' });
      }
      const contentType = imgRes.headers.get('content-type') || 'image/jpeg';
      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'private, max-age=3600');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      const buffer = Buffer.from(await imgRes.arrayBuffer());
      return res.send(buffer);
    } catch {
      return res.status(500).json({ error: 'Gagal memuat gambar.' });
    }
  }

  // --- Mode 2: Google Drive file ID → proxy image bytes ---
  if (!id || !/^[a-zA-Z0-9_-]{10,}$/.test(id)) {
    return res.status(400).json({ error: 'Parameter tidak valid.' });
  }

  try {
    const driveUrl = `https://drive.google.com/uc?export=view&id=${id}`;
    const response = await fetchWithTimeout(driveUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'image/*,*/*',
      },
      redirect: 'follow',
    });

    if (!response.ok) {
      return res.status(404).json({ error: 'Gambar tidak ditemukan.' });
    }

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.startsWith('image/')) {
      return res.status(415).json({ error: 'Bukan file gambar.' });
    }

    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    const buffer = await response.arrayBuffer();
    res.send(Buffer.from(buffer));
  } catch {
    res.status(502).json({ error: 'Gagal mengambil gambar.' });
  }
};

