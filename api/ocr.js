const { cors } = require('./_cors');
const { logError } = require('./_logger');
const { rateLimit } = require('./_ratelimit');

const ocrLimiter = rateLimit({ windowMs: 60 * 1000, max: 10 }); // 10 req/min per IP

function extractJsonCandidate(content) {
  const raw = String(content || '').trim();
  if (!raw) return '';

  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : raw;
  const objectMatch = candidate.match(/\{[\s\S]*\}/);
  return objectMatch ? objectMatch[0].trim() : candidate;
}

function sanitizeLooseJson(candidate) {
  return String(candidate || '')
    .replace(/:\s*(Unknown|unknown|N\/A|n\/a|None|none)(?=\s*[,}])/g, ': null')
    .replace(/,\s*([}\]])/g, '$1')
    .trim();
}

function parseGroqOcrContent(content) {
  const candidate = extractJsonCandidate(content);
  const attempts = [candidate, sanitizeLooseJson(candidate)].filter(Boolean);
  let lastError = null;

  for (const attempt of attempts) {
    try {
      return JSON.parse(attempt);
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError || new Error('Respons OCR kosong atau tidak valid.');
}

function pickDefined(primary, fallback) {
  return primary !== undefined ? primary : fallback;
}

function extractLooseField(content, fieldName) {
  const raw = String(content || '');
  const escapedField = fieldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(
    `(?:"${escapedField}"|'${escapedField}'|${escapedField})\\s*[:=]\\s*(?:"([^"]*)"|'([^']*)'|([^,\\n}\\]]+))`,
    'i'
  );
  const match = raw.match(regex);
  if (!match) return undefined;
  return [match[1], match[2], match[3]].find(value => value !== undefined)?.trim();
}

function extractLooseOcrFields(content) {
  return {
    is_receipt: extractLooseField(content, 'is_receipt'),
    Channel: extractLooseField(content, 'Channel'),
    Total_Bayar: extractLooseField(content, 'Total_Bayar'),
    Admin: extractLooseField(content, 'Admin'),
  };
}

function coerceNullableInteger(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value);
  const text = String(value || '').trim();
  if (!text || /^(null|unknown|n\/a|none|undefined)$/i.test(text)) return null;
  const digits = text.replace(/[^\d-]/g, '');
  if (!digits || !/^-?\d+$/.test(digits)) return null;
  const num = Number(digits);
  return Number.isFinite(num) ? num : null;
}

function coerceNullableString(value) {
  const text = String(value || '').trim();
  if (!text || /^(null|unknown|n\/a|none|undefined)$/i.test(text)) return null;
  return text;
}

function coerceBooleanOrNull(value) {
  if (value === true || value === false) return value;
  const text = String(value || '').trim().toLowerCase();
  if (text === 'true') return true;
  if (text === 'false') return false;
  return null;
}

const handler = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (cors(req, res, { methods: 'POST, OPTIONS' })) return;

  if (await ocrLimiter(req, res)) return;

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
                text: 'Task: Analyze this image. First, determine if it is a bank transfer receipt, payment proof, or financial transaction screenshot. Output MUST be a valid raw JSON object ONLY. No markdown, no backticks, no preamble. Use exactly these fields and valid JSON types: {"is_receipt": boolean, "Channel": string|null, "Total_Bayar": integer|null, "Admin": integer|null}. Use null when a value is unknown. If the image is NOT a bank receipt/payment proof/transaction screenshot, set is_receipt to false and all other fields to null.',
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

    const looseFields = extractLooseOcrFields(content);
    let parsed;
    try {
      parsed = parseGroqOcrContent(content);
    } catch (parseErr) {
      const hasLooseFallback = Object.values(looseFields).some(value => value !== undefined);
      if (!hasLooseFallback) {
        logError('ocr', 'Failed to parse Groq response', {
          content: content.slice(0, 500),
          error: parseErr.message,
        });
        return res.status(502).json({ error: 'Gagal membaca data dari gambar.' });
      }
      parsed = looseFields;
    }

    parsed = {
      is_receipt: pickDefined(parsed.is_receipt, looseFields.is_receipt),
      Channel: pickDefined(parsed.Channel, looseFields.Channel),
      Total_Bayar: pickDefined(parsed.Total_Bayar, looseFields.Total_Bayar),
      Admin: pickDefined(parsed.Admin, looseFields.Admin),
    };

    const isReceipt = coerceBooleanOrNull(parsed.is_receipt);
    const channel = coerceNullableString(parsed.Channel);
    const totalBayar = coerceNullableInteger(parsed.Total_Bayar);
    const adminValue = coerceNullableInteger(parsed.Admin);

    // Validate: is this actually a bank receipt?
    if (isReceipt === false) {
      return res.status(400).json({ error: 'Gambar bukan bukti transfer atau struk bank. Upload screenshot bukti transfer.' });
    }

    // Compute nominal = Total_Bayar - Admin
    const admin = adminValue !== null ? adminValue : 0;
    const nominal = totalBayar !== null ? totalBayar - admin : null;

    return res.json({
      channel: channel || 'Unknown',
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
