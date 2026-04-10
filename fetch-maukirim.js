/**
 * fetch-maukirim.js
 * Ambil data orders & account dari app.maukirim.id
 * Jalankan: node fetch-maukirim.js
 * Baca .env otomatis, butuh: MAUKIRIM_WA dan MAUKIRIM_PASS
 */

require('dotenv').config();
const https = require('https');
const querystring = require('querystring');

const BASE = 'https://app.maukirim.id';
const WA   = process.env.MAUKIRIM_WA   || '';
const PASS = process.env.MAUKIRIM_PASS || '';

if (!WA || !PASS) {
  console.error('Set env: MAUKIRIM_WA dan MAUKIRIM_PASS');
  process.exit(1);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function request(options, body = null) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// Follow redirects, accumulate cookies
async function requestFollow(path, method, headers, body, cookies, maxRedirects = 5) {
  let currentPath = path;
  for (let i = 0; i < maxRedirects; i++) {
    const opts = { hostname: 'app.maukirim.id', path: currentPath, method, headers: { ...headers, 'Cookie': cookieStr(cookies) } };
    if (body && i === 0) opts.headers['Content-Length'] = Buffer.byteLength(body);
    const r = await request(opts, i === 0 ? body : null);
    const newCookies = parseCookies(r.headers['set-cookie']);
    Object.assign(cookies, newCookies);
    if (r.status >= 300 && r.status < 400 && r.headers['location']) {
      const loc = r.headers['location'];
      currentPath = loc.startsWith('http') ? new URL(loc).pathname : loc;
      method = 'GET';
      body = null;
      headers = { ...headers };
      delete headers['Content-Type'];
      delete headers['Content-Length'];
      continue;
    }
    return r;
  }
  throw new Error('Too many redirects');
}

function parseCookies(setCookieArr) {
  if (!setCookieArr) return {};
  const out = {};
  for (const line of setCookieArr) {
    const [pair] = line.split(';');
    const [k, v] = pair.split('=');
    if (k && v !== undefined) out[k.trim()] = v.trim();
  }
  return out;
}

function cookieStr(obj) {
  return Object.entries(obj).map(([k, v]) => `${k}=${v}`).join('; ');
}

// ── Step 1: GET / untuk ambil CSRF token ─────────────────────────────────────

async function run() {
  console.log('1. Ambil CSRF token...');
  const r1 = await request({ hostname: 'app.maukirim.id', path: '/', method: 'GET',
    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/html' } });

  let cookies = parseCookies(r1.headers['set-cookie']);
  const xsrfRaw = cookies['XSRF-TOKEN'] || '';
  const csrfToken = decodeURIComponent(xsrfRaw);

  // Cari _token di HTML (Laravel hidden input) — toleran terhadap minified HTML
  const tokenMatch = r1.body.match(/name=[\"']_token[\"']\s+value=[\"']([^\"']+)[\"']/)
    || r1.body.match(/value=[\"']([^\"']{20,})[\"']\s+name=[\"']_token[\"']/)
    || r1.body.match(/"_token":"([^"]+)"/)
    || r1.body.match(/name=_token value=([^\s>]+)/);
  const _token = tokenMatch ? tokenMatch[1] : '';

  if (!_token) {
    console.error('Gagal ambil _token dari halaman login. Body:\n', r1.body.slice(0, 500));
    process.exit(1);
  }
  console.log('   _token OK');

  // ── Step 2: POST /login ─────────────────────────────────────────────────────

  console.log('2. Login...');
  const payload = querystring.stringify({
    _token,
    whatsapp: WA,
    password: PASS,
    remember: 'on',
  });

  const r2 = await requestFollow('/login', 'POST', {
    'Content-Type': 'application/x-www-form-urlencoded',
    'Referer': BASE + '/',
    'Origin': BASE,
    'User-Agent': 'Mozilla/5.0',
    'Accept': 'text/html,application/xhtml+xml',
  }, payload, cookies);

  if (r2.body.includes('Selamat Datang') || r2.body.includes('kata sandi')) {
    console.error('Login gagal — cek nomor WA / password');
    process.exit(1);
  }
  console.log('   Login OK, status:', r2.status);

  // ── Step 3: Fetch /orders ───────────────────────────────────────────────────

  console.log('3. Ambil /orders...');
  const r3 = await requestFollow('/orders', 'GET', {
    'User-Agent': 'Mozilla/5.0',
    'Accept': 'text/html',
  }, null, cookies);

  if (r3.body.includes('Selamat Datang')) {
    console.error('   /orders: masih di halaman login — cek kredensial');
  } else {
    require('fs').writeFileSync('maukirim-orders.html', r3.body);
    console.log('   Disimpan ke maukirim-orders.html (' + r3.body.length + ' bytes)');
  }

  // ── Step 4: Fetch /account/data/5 ──────────────────────────────────────────

  console.log('4. Ambil /account/data/5...');
  const r4 = await requestFollow('/account/data/5', 'GET', {
    'User-Agent': 'Mozilla/5.0',
    'Accept': 'application/json, text/html',
    'X-Requested-With': 'XMLHttpRequest',
  }, null, cookies);

  require('fs').writeFileSync('maukirim-account-5.txt', r4.body);
  console.log('   Disimpan ke maukirim-account-5.txt (' + r4.body.length + ' bytes)');
  console.log('\nSelesai.');
}

run().catch(err => { console.error(err); process.exit(1); });
