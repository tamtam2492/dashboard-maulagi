/**
 * _probe-login.js  — coba berbagai kombinasi field name login
 * node _probe-login.js
 */
require('dotenv').config();
const https = require('https');
const querystring = require('querystring');

const WA   = process.env.MAUKIRIM_WA;
const PASS = process.env.MAUKIRIM_PASS;

function req(options, body) {
  return new Promise((resolve, reject) => {
    const r = https.request(options, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: d }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

function parseCookies(arr) {
  if (!arr) return {};
  const out = {};
  for (const line of arr) {
    const [pair] = line.split(';');
    const [k, ...rest] = pair.split('=');
    if (k) out[k.trim()] = rest.join('=').trim();
  }
  return out;
}

function cookieStr(obj) {
  return Object.entries(obj).map(([k, v]) => `${k}=${v}`).join('; ');
}

async function tryLogin(waField, passField) {
  // GET homepage untuk token
  const r1 = await req({ hostname: 'app.maukirim.id', path: '/', method: 'GET',
    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/html' } });
  const cookies = parseCookies(r1.headers['set-cookie']);
  const tm = r1.body.match(/name=_token value=([^\s>]+)/)
    || r1.body.match(/name=['"_]token['"]\s+value=['"]([^'"]+)['"]/)
    || r1.body.match(/"_token":"([^"]+)"/)
    || r1.body.match(/value="([A-Za-z0-9+/]{20,}={0,2})"\s+name="_token"/);
  const _token = tm ? tm[1].replace(/['"]/g, '') : '';

  const payload = querystring.stringify({ _token, [waField]: WA, [passField]: PASS });
  const r2 = await req({
    hostname: 'app.maukirim.id', path: '/login', method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(payload),
      'Cookie': cookieStr(cookies),
      'Referer': 'https://app.maukirim.id/',
      'Origin': 'https://app.maukirim.id',
      'User-Agent': 'Mozilla/5.0',
      'Accept': 'text/html',
    }
  }, payload);

  const loc = r2.headers['location'] || '';
  const success = r2.status === 302 && !loc.includes('/login') && !loc.endsWith('/');
  console.log(`[${waField}/${passField}] status=${r2.status} → ${loc || '(no redirect)'} ${success ? '✓ BERHASIL' : ''}`);
  return { success, cookies: { ...cookies, ...parseCookies(r2.headers['set-cookie']) }, loc };
}

(async () => {
  const combos = [
    ['whatsapp', 'password'],
    ['phone', 'password'],
    ['wa', 'password'],
    ['no_wa', 'password'],
    ['nomor_wa', 'password'],
    ['email', 'password'],
    ['username', 'password'],
    ['hp', 'password'],
  ];
  for (const [wf, pf] of combos) {
    const { success } = await tryLogin(wf, pf);
    if (success) { console.log(`\n✓ Field yang benar: ${wf} / ${pf}`); break; }
    await new Promise(r => setTimeout(r, 500));
  }
})();
