const https = require('https');
https.get('https://app.maukirim.id/', { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/html' } }, res => {
  let d = ''; res.on('data', c => d += c); res.on('end', () => {
    const patterns = [
      /name=_token value=([^\s>]+)/,
      /name=['"]_token['"] value=['"]([^'"]+)['"]/,
      /value=['"]([^'"]+)['"] name=['"]_token['"]/,
      /value=([A-Za-z0-9+\/]{20,}={0,2}) name=_token/,
      /"_token":"([^"]+)"/
    ];
    let found = false;
    for (const p of patterns) {
      const m = d.match(p);
      if (m) { console.log('MATCH:', p.toString().slice(0, 50), '->', m[1].slice(0, 30)); found = true; }
    }
    if (!found) console.log('NO MATCH - context around _token:');
    const idx = d.indexOf('_token');
    if (idx > 0) console.log('Context:', JSON.stringify(d.slice(idx - 30, idx + 80)));
    console.log('\nCookies:', JSON.stringify(res.headers['set-cookie']));
  });
});
