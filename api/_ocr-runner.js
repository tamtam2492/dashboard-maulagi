const { logError } = require('./_logger');
const { parseOcrResponseContent, resolveOcrNominal } = require('./_ocr-utils');

function getGroqApiKey(env = process.env) {
  return String(env.GROQ_API_KEY || '').replace(/^Bearer\s+/i, '').trim();
}

async function requestGroqOcr(imageDataUrl, env = process.env, fetchImpl = globalThis.fetch) {
  const apiKey = getGroqApiKey(env);
  if (!apiKey) {
    throw new Error('GROQ_API_KEY belum dikonfigurasi.');
  }

  if (typeof fetchImpl !== 'function') {
    throw new Error('Fetch OCR tidak tersedia.');
  }

  const groqRes = await fetchImpl('https://api.groq.com/openai/v1/chat/completions', {
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
              text: 'Task: Analyze this image. First, determine if it is a bank transfer receipt, payment proof, or financial transaction screenshot. Output MUST be a valid raw JSON object ONLY. No markdown, no backticks, no preamble. Use exactly these fields and valid JSON types: {"is_receipt": boolean, "Channel": string|null, "Total_Bayar": integer|null, "Jumlah_Kirim_Uang": integer|null, "Admin": integer|null, "Admin_Dibayar": boolean|null}. Use null when a value is unknown. "Total_Bayar" is the total amount paid by sender. "Jumlah_Kirim_Uang" is the actual amount sent/received by destination. "Admin" is the admin fee actually paid after promo/discount, not just any crossed-out number shown on screen. If admin is struck through, crossed out, labeled Gratis/free/waived, promo-applied, or Total_Bayar equals Jumlah_Kirim_Uang, set Admin to 0 and Admin_Dibayar to false. If admin is truly charged, set Admin_Dibayar to true. If the image is NOT a bank receipt/payment proof/transaction screenshot, set is_receipt to false and all other fields to null.',
            },
            {
              type: 'image_url',
              image_url: { url: imageDataUrl },
            },
          ],
        },
      ],
      temperature: 0,
    }),
  });

  if (!groqRes.ok) {
    logError('ocr', `Groq API error: ${groqRes.status}`, { path: '/ocr-worker' });
    throw new Error('Gagal memproses gambar.');
  }

  const groqJson = await groqRes.json();
  const content = String(groqJson.choices?.[0]?.message?.content || '').trim();

  let parsed;
  try {
    parsed = parseOcrResponseContent(content);
  } catch (parseErr) {
    logError('ocr', 'Failed to parse Groq response', {
      content: parseErr.contentPreview || content.slice(0, 500),
      error: parseErr.message,
    });
    throw new Error('Gagal membaca data dari gambar.');
  }

  const { isReceipt, channel } = parsed;
  const resolved = resolveOcrNominal(parsed);

  if (isReceipt === false) {
    throw new Error('Gambar bukan bukti transfer atau struk bank. Upload screenshot bukti transfer.');
  }

  return {
    channel: channel || 'Unknown',
    total_bayar: resolved.totalBayar,
    jumlah_kirim_uang: resolved.jumlahKirimUang,
    admin: resolved.effectiveAdmin,
    admin_dibayar: resolved.adminDibayar,
    nominal: resolved.nominal,
  };
}

module.exports = {
  getGroqApiKey,
  requestGroqOcr,
};