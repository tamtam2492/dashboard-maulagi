const fs = require('fs');
const html = fs.readFileSync('maukirim-orders.html','utf8');
// Look for pagination
const pageM = html.match(/page[^>"']*=\d+|pagination|next.*page|halaman/gi);
if (pageM) console.log('Pagination:', [...new Set(pageM)].slice(0,10));
// Look for date filter forms
const formM = html.match(/input[^>]*(date|dari|sampai|bulan|month|periode)[^>]*/gi);
if (formM) console.log('Date inputs:', formM.slice(0,5));
// Look for filter/select options  
const selM = html.match(/select[^>]+>([\s\S]*?)<\/select>/gi);
if (selM) selM.slice(0,5).forEach(s => console.log('SELECT:', s.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim().slice(0,200)));
// URL params in links
const linkM = html.match(/href=['"][^'"]*\?(page|bulan|dari|month)[^'"]*['"]/gi);
if (linkM) console.log('Links:', linkM.slice(0,5));
// Form actions
const fa = html.match(/form[^>]*action=['"]([^'"]+)['"]/gi);
if (fa) console.log('Forms:', fa.slice(0,5));
// Any JS with date/filter
const jsFilter = html.match(/\?(dari|sampai|bulan|page|filter)[^'"]{0,80}/gi);
if (jsFilter) console.log('JS filter refs:', jsFilter.slice(0,8));
