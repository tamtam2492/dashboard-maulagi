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

(async () => {
  // Step 1: GET homepage
  const r1 = await req({ hostname: 'app.maukirim.id', path: '/', method: 'GET',
    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/html' } });
  const cookies = parseCookies(r1.headers['set-cookie']);
  console.log('Cookies from GET:', Object.keys(cookies));

  const tm = r1.body.match(/name=_token value=([^\s>]+)/);
  const _token = tm ? tm[1] : '';
  console.log('_token:', _token ? _token.slice(0, 20) + '...' : 'NOT FOUND');

  // Step 2: POST login
  const payload = querystring.stringify({ _token, whatsapp: WA, password: PASS });
  console.log('\nPOST payload fields:', Object.keys(querystring.parse(payload)));
  console.log('whatsapp value:', WA);

  const r2 = await req({
    hostname: 'app.maukirim.id', path: '/login', method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(payload),
      'Cookie': cookieStr(cookies),
      'Referer': 'https://app.maukirim.id/',
      'Origin': 'https://app.maukirim.id',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'id-ID,id;q=0.9',
    }
  }, payload);

  console.log('\nPOST response status:', r2.status);
  console.log('Location:', r2.headers['location'] || '(none)');
  console.log('Set-Cookie:', (r2.headers['set-cookie'] || []).map(c => c.split(';')[0].split('=')[0]));
  // Show body snippet if not redirect
  if (r2.status !== 302) {
    console.log('Body snippet:', r2.body.slice(0, 300));
  }
})();
