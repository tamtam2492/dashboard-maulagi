const { cors } = require('./_cors');
const { logError } = require('./_logger');
const { rateLimit } = require('./_ratelimit');

const ocrLimiter = rateLimit({ windowMs: 60 * 1000, max: 10 }); // 10 req/min per IP

const handler = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (cors(req, res, { methods: 'POST, OPTIONS' })) return;

  if (ocrLimiter(req, res)) return;

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  try {
    const { image } = req.body || {};
    if (!image || typeof image !== 'string') {
      return res.status(400).json({ error: 'Field image (base64) diperlukan.' });
    }

    // Validate base64 data URL format
    if (!image.startsWith('data:image/')) {
      return res.status(400).json({ error: 'Format image tidak valid.' });
    }

    const apiKey = (process.env.GROQ_API_KEY || '').replace(/^Bearer\s+/i, '').trim();
    if (!apiKey) {
      return res.status(500).json({ error: 'GROQ_API_KEY belum dikonfigurasi.' });
    }

    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'meta-llama/llama-4-scout-17b-16e-instruct',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'Task: Analyze this image. First, determine if it is a bank transfer receipt, payment proof, or financial transaction screenshot. Output MUST be a valid raw JSON object ONLY. No markdown, no backticks, no preamble. Fields: {"is_receipt": boolean, "Channel": string, "Total_Bayar": integer or "Unknown", "Admin": integer or "Unknown"}. If the image is NOT a bank receipt/payment proof/transaction screenshot, set is_receipt to false and all other fields to "Unknown".',
              },
              {
                type: 'image_url',
                image_url: { url: image },
              },
            ],
          },
        ],
        temperature: 0,
      }),
    });

    if (!groqRes.ok) {
      logError('ocr', `Groq API error: ${groqRes.status}`, { path: '/ocr' });
      return res.status(502).json({ error: 'Gagal memproses gambar.' });
    }

    const groqJson = await groqRes.json();
    const content = (groqJson.choices?.[0]?.message?.content || '').trim();

    // Parse JSON from response — handle possible markdown wrapping
    let parsed;
    try {
      // Try direct parse first
      parsed = JSON.parse(content);
    } catch {
      // Try extracting JSON from markdown code block
      const match = content.match(/\{[\s\S]*\}/);
      if (match) {
        parsed = JSON.parse(match[0]);
      } else {
        logError('ocr', 'Failed to parse Groq response', { content: content.slice(0, 500) });
        return res.status(502).json({ error: 'Gagal membaca data dari gambar.' });
      }
    }

    // Validate: is this actually a bank receipt?
    if (parsed.is_receipt === false) {
      return res.status(400).json({ error: 'Gambar bukan bukti transfer atau struk bank. Upload screenshot bukti transfer.' });
    }

    // Compute nominal = Total_Bayar - Admin
    const totalBayar = typeof parsed.Total_Bayar === 'number' ? parsed.Total_Bayar : null;
    const admin = typeof parsed.Admin === 'number' ? parsed.Admin : 0;
    const nominal = totalBayar !== null ? totalBayar - admin : null;

    return res.json({
      channel: parsed.Channel || 'Unknown',
      total_bayar: totalBayar,
      admin: admin,
      nominal: nominal,
    });
  } catch (err) {
    console.error(err);
    logError('ocr', err.message, { method: 'POST' });
    return res.status(500).json({ error: 'Terjadi kesalahan server.' });
  }
};

module.exports = handler;
module.exports.config = { api: { bodyParser: { sizeLimit: '4.5mb' } } };
