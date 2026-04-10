const https = require('https');
https.get('https://app.maukirim.id/', { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
  let d = ''; res.on('data', c => d += c); res.on('end', () => {
    const m = d.match(/input[^>]+name=["']([^"']+)["'][^>]*/gi);
    if (m) m.forEach(x => console.log(x.slice(0, 150)));
    else console.log('No inputs found');
    // Also check for form action
    const fa = d.match(/form[^>]+action=["']([^"']+)["']/i);
    if (fa) console.log('Form action:', fa[0]);
  });
});
