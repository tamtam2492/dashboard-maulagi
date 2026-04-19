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

async function loginMaukirim() {
  const wa = process.env.MAUKIRIM_WA;
  const pass = process.env.MAUKIRIM_PASS;
  if (!wa || !pass) throw new Error('MAUKIRIM_WA/PASS not set');

  const r1 = await httpReq({
    hostname: MK_HOST,
    path: '/',
    method: 'GET',
    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/html' },
  });
  const ck = parseCk(r1.headers['set-cookie']);
  const tm = r1.body.match(/name=_token value=([^\s>]+)/);
  if (!tm) throw new Error('CSRF token not found');

  const payload = querystring.stringify({ _token: tm[1], whatsapp: wa, password: pass });
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

  for (let i = 0; i < 5; i++) {
    const res = await httpReq({ hostname: MK_HOST, path, method, headers }, body);
    Object.assign(ck, parseCk(res.headers['set-cookie']));
    if (res.status >= 300 && res.status < 400 && res.headers.location) {
      const loc = res.headers.location;
      path = loc.startsWith('http') ? new URL(loc).pathname : loc;
      if (path === '/login' || path === '/') throw new Error('Login gagal');
      method = 'GET';
      body = null;
      headers = {
        'Cookie': ckStr(ck),
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'text/html',
      };
      continue;
    }
    break;
  }

  return ck;
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
  ckStr,
  httpReq,
  loginMaukirim,
  downloadOrdersWorkbook,
  getPeriodeDateRange,
  fetchMaukirimSenders,
};