const https = require('https');
const querystring = require('querystring');

const MK_HOST = 'app.maukirim.id';

function httpReq(options, body, responseType = 'text') {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: responseType === 'buffer' ? buffer : buffer.toString('utf8'),
        });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function parseCk(arr) {
  const out = {};
  for (const line of (arr || [])) {
    const [pair] = line.split(';');
    const ei = pair.indexOf('=');
    if (ei > 0) out[pair.slice(0, ei).trim()] = pair.slice(ei + 1).trim();
  }
  return out;
}

function ckStr(obj) {
  return Object.entries(obj).map(([k, v]) => `${k}=${v}`).join('; ');
}

function createMaukirimError(message, code = 'MAUKIRIM_UPSTREAM_ERROR') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizeMaukirimRedirectPath(location) {
  const rawLocation = String(location || '').trim();
  if (!rawLocation) return '';

  if (!rawLocation.startsWith('http')) return rawLocation;

  try {
    const url = new URL(rawLocation);
    return `${url.pathname || ''}${url.search || ''}` || '';
  } catch {
    return '';
  }
}

function isMaukirimLoginPage(body) {
  const html = String(body || '');
  return /name\s*=\s*["']?_token["']?/i.test(html)
    && /name\s*=\s*["']?whatsapp["']?/i.test(html)
    && /name\s*=\s*["']?password["']?/i.test(html);
}

async function performMaukirimCredentialLogin(requestFn, wa, pass) {
  const loginWa = String(wa || '').replace(/\s+/g, '').trim();
  const loginPass = String(pass || '');
  if (!loginWa || !loginPass) {
    throw createMaukirimError('Kredensial Maukirim tidak lengkap.', 'MAUKIRIM_AUTH_FAILED');
  }

  let r1;
  try {
    r1 = await requestFn({
      hostname: MK_HOST,
      path: '/',
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/html' },
    });
  } catch (err) {
    throw createMaukirimError(err.message || 'Gagal menghubungi Maukirim.', 'MAUKIRIM_UPSTREAM_ERROR');
  }

  if (!r1 || r1.status >= 400) {
    throw createMaukirimError(`Maukirim login bootstrap gagal (${r1 && r1.status ? r1.status : 0})`, 'MAUKIRIM_UPSTREAM_ERROR');
  }

  const ck = parseCk(r1.headers['set-cookie']);
  const tm = String(r1.body || '').match(/name\s*=\s*["']?_token["']?\s+value\s*=\s*["']?([^\s"'>]+)/i);
  if (!tm) throw createMaukirimError('CSRF token Maukirim tidak ditemukan.', 'MAUKIRIM_UPSTREAM_ERROR');

  const payload = querystring.stringify({ _token: tm[1], whatsapp: loginWa, password: loginPass });
  let path = '/login';
  let method = 'POST';
  let body = payload;
  let headers = {
    'Content-Type': 'application/x-www-form-urlencoded',
    'Content-Length': Buffer.byteLength(payload),
    'Cookie': ckStr(ck),
    'Referer': `https://${MK_HOST}/`,
    'Origin': `https://${MK_HOST}`,
    'User-Agent': 'Mozilla/5.0',
    'Accept': 'text/html',
  };

  let lastResponse = null;

  for (let i = 0; i < 5; i++) {
    let res;
    try {
      res = await requestFn({ hostname: MK_HOST, path, method, headers }, body);
    } catch (err) {
      throw createMaukirimError(err.message || 'Gagal menghubungi Maukirim.', 'MAUKIRIM_UPSTREAM_ERROR');
    }

    lastResponse = res;
    Object.assign(ck, parseCk(res.headers['set-cookie']));
    if (res.status >= 500) {
      throw createMaukirimError(`Maukirim login returned ${res.status}`, 'MAUKIRIM_UPSTREAM_ERROR');
    }

    if (res.status >= 300 && res.status < 400 && res.headers.location) {
      path = normalizeMaukirimRedirectPath(res.headers.location);
      if (!path || path === '/' || path.startsWith('/login')) {
        throw createMaukirimError('Login gagal.', 'MAUKIRIM_AUTH_FAILED');
      }
      method = 'GET';
      body = null;
      headers = {
        'Cookie': ckStr(ck),
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'text/html',
      };
      continue;
    }

    if (method === 'POST') {
      throw createMaukirimError('Login gagal.', 'MAUKIRIM_AUTH_FAILED');
    }

    break;
  }

  if (!lastResponse) {
    throw createMaukirimError('Maukirim tidak mengembalikan respons login.', 'MAUKIRIM_UPSTREAM_ERROR');
  }

  if (lastResponse.status >= 300 && lastResponse.status < 400) {
    throw createMaukirimError('Redirect login Maukirim tidak selesai.', 'MAUKIRIM_UPSTREAM_ERROR');
  }

  if (lastResponse.status >= 400) {
    throw createMaukirimError(`Maukirim login final returned ${lastResponse.status}`, 'MAUKIRIM_UPSTREAM_ERROR');
  }

  if (isMaukirimLoginPage(lastResponse.body)) {
    throw createMaukirimError('Login gagal.', 'MAUKIRIM_AUTH_FAILED');
  }

  return ck;
}

async function loginMaukirimWithCredentials(wa, pass) {
  return performMaukirimCredentialLogin(httpReq, wa, pass);
}

async function loginMaukirim() {
  const wa = process.env.MAUKIRIM_WA;
  const pass = process.env.MAUKIRIM_PASS;
  if (!wa || !pass) throw createMaukirimError('MAUKIRIM_WA/PASS not set', 'MAUKIRIM_UPSTREAM_ERROR');
  return loginMaukirimWithCredentials(wa, pass);
}

function getPeriodeDateRange(periode) {
  const [year, month] = String(periode || '').split('-').map(Number);
  if (!year || !month) throw new Error('Periode tidak valid');
  const start = new Date(year, month - 1, 1);
  const end = new Date(year, month, 0);
  const fmt = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  return { date_start: fmt(start), date_end: fmt(end) };
}

async function downloadOrdersWorkbook(ck, periode) {
  const { date_start, date_end } = getPeriodeDateRange(periode);
  const params = new URLSearchParams({ date_start, date_end, date_by: 'created_at' });
  const res = await httpReq({
    hostname: MK_HOST,
    path: `/orders/download?${params.toString()}`,
    method: 'GET',
    headers: {
      'Cookie': ckStr(ck),
      'User-Agent': 'Mozilla/5.0',
      'Accept': '*/*',
      'Referer': `https://${MK_HOST}/orders`,
    },
  }, null, 'buffer');

  if (res.status >= 400) {
    throw new Error(`Export MauKirim gagal (${res.status})`);
  }
  const contentType = String(res.headers['content-type'] || '').toLowerCase();
  if (!contentType.includes('spreadsheetml') && !contentType.includes('application/octet-stream')) {
    throw new Error('Export MauKirim tidak mengembalikan file XLSX');
  }
  return res.body;
}

/**
 * Ambil daftar sub-akun Maukirim (/account/data/5).
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
  for (let i = 6; i + 4 < cells.length; i += 6) {
    const name = cells[i + 2];
    const wa = cells[i + 3];
    if (name && wa && /^0[0-9]{7,14}$/.test(wa)) {
      senders.push({ name: name.trim().toUpperCase(), wa: wa.trim() });
    }
  }
  return senders;
}

module.exports = {
  MK_HOST,
  createMaukirimError,
  ckStr,
  httpReq,
  isMaukirimLoginPage,
  loginMaukirim,
  loginMaukirimWithCredentials,
  normalizeMaukirimRedirectPath,
  performMaukirimCredentialLogin,
  downloadOrdersWorkbook,
  getPeriodeDateRange,
  fetchMaukirimSenders,
};