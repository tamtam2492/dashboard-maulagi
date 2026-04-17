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
    Jumlah_Kirim_Uang: extractLooseField(content, 'Jumlah_Kirim_Uang') ?? extractLooseField(content, 'Jumlah Kirim Uang'),
    Admin: extractLooseField(content, 'Admin'),
    Admin_Dibayar: extractLooseField(content, 'Admin_Dibayar') ?? extractLooseField(content, 'Admin Dibayar'),
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

function parseOcrResponseContent(content) {
  const looseFields = extractLooseOcrFields(content);
  let parsed;

  try {
    parsed = parseGroqOcrContent(content);
  } catch (parseErr) {
    const hasLooseFallback = Object.values(looseFields).some(value => value !== undefined);
    if (!hasLooseFallback) {
      parseErr.contentPreview = String(content || '').trim().slice(0, 500);
      throw parseErr;
    }
    parsed = looseFields;
  }

  parsed = {
    is_receipt: pickDefined(parsed.is_receipt, looseFields.is_receipt),
    Channel: pickDefined(parsed.Channel, looseFields.Channel),
    Total_Bayar: pickDefined(parsed.Total_Bayar, looseFields.Total_Bayar),
    Jumlah_Kirim_Uang: pickDefined(parsed.Jumlah_Kirim_Uang, looseFields.Jumlah_Kirim_Uang),
    Admin: pickDefined(parsed.Admin, looseFields.Admin),
    Admin_Dibayar: pickDefined(parsed.Admin_Dibayar, looseFields.Admin_Dibayar),
  };

  return {
    isReceipt: coerceBooleanOrNull(parsed.is_receipt),
    channel: coerceNullableString(parsed.Channel),
    totalBayar: coerceNullableInteger(parsed.Total_Bayar),
    jumlahKirimUang: coerceNullableInteger(parsed.Jumlah_Kirim_Uang),
    admin: coerceNullableInteger(parsed.Admin),
    adminDibayar: coerceBooleanOrNull(parsed.Admin_Dibayar),
    raw: parsed,
  };
}

function resolveOcrNominal(parsed) {
  const totalBayar = coerceNullableInteger(parsed && parsed.totalBayar);
  const jumlahKirimUang = coerceNullableInteger(parsed && parsed.jumlahKirimUang);
  const admin = coerceNullableInteger(parsed && parsed.admin);
  const adminDibayar = coerceBooleanOrNull(parsed && parsed.adminDibayar);
  const effectiveAdmin = adminDibayar === false ? 0 : (admin !== null ? admin : 0);

  return {
    totalBayar,
    jumlahKirimUang,
    admin,
    adminDibayar,
    effectiveAdmin,
    nominal: jumlahKirimUang !== null
      ? jumlahKirimUang
      : (totalBayar !== null ? Math.max(totalBayar - effectiveAdmin, 0) : null),
  };
}

module.exports = {
  coerceBooleanOrNull,
  coerceNullableInteger,
  coerceNullableString,
  extractJsonCandidate,
  extractLooseField,
  extractLooseOcrFields,
  parseGroqOcrContent,
  parseOcrResponseContent,
  pickDefined,
  resolveOcrNominal,
  sanitizeLooseJson,
};