const { createClient } = require('@supabase/supabase-js');
const { cors } = require('./_cors');
const { logError } = require('./_logger');
const { MK_HOST, httpReq, ckStr, loginMaukirim } = require('./_maukirim');

function getSupabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
}

// ── Maukirim helpers ─────────────────────────────────────────────────────────
const MAUKIRIM_CACHE_TTL_MS = 60 * 1000;
const maukirimCache = {
  expiresAt: 0,
  orders: null,
  pending: null,
};

function normalizeCabangName(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .replace(/^CABANG\s+/, '')
    .trim();
}

function isMaukirimRequest(req) {
  return req.query.action === 'maukirim' || String(req.url || '').startsWith('/api/maukirim');
}

function parseOrders(html) {
  const orders = [];
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let m;
  while ((m = trRe.exec(html)) !== null) {
    const tds = m[1].match(/<td[^>]*>([\s\S]*?)<\/td>/gi);
    if (!tds || tds.length < 7) continue;
    const clean = t => t.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
    const col1 = clean(tds[0]);
    if (!col1 || isNaN(parseInt(col1))) continue;
    const resiM = clean(tds[2]).match(/^(\S+)/);
    const cabangM = clean(tds[4]).match(/Dibuat oleh\s*:\s*(.+)/i);
    orders.push({
      no: parseInt(col1),
      tanggal: clean(tds[1]),
      resi: resiM ? resiM[1] : clean(tds[2]),
      penerima: clean(tds[3]),
      ekspedisi: clean(tds[4]).split('Dibuat')[0].trim(),
      cabang: cabangM ? cabangM[1].trim() : '',
      total: clean(tds[5]),
      metode: clean(tds[6]).toLowerCase(),
      status: tds[7] ? clean(tds[7]) : '',
    });
  }
  return orders;
}

function getTwoMonthRange() {
  const now = new Date();
  // First day of previous month
  const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  // Last day of current month
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  const fmt = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  return { date_start: fmt(start), date_end: fmt(end) };
}

async function fetchOrdersPage(ck, page, dateRange) {
  const params = new URLSearchParams({
    date_start: dateRange.date_start,
    date_end: dateRange.date_end,
    date_by: 'created_at',
    page: String(page),
  });
  const r = await httpReq({
    hostname: MK_HOST,
    path: `/orders?${params.toString()}`,
    method: 'GET',
    headers: {
      'Cookie': ckStr(ck),
      'User-Agent': 'Mozilla/5.0',
      'Accept': 'text/html',
      'Referer': `https://${MK_HOST}/orders`,
    },
  });
  return r.body;
}

async function fetchAllOrders(ck) {
  const dateRange = getTwoMonthRange();
  const allOrders = [];
  let page = 1;
  const MAX_PAGES = 20; // safety limit

  while (page <= MAX_PAGES) {
    const html = await fetchOrdersPage(ck, page, dateRange);
    if (html.includes('Selamat Datang')) throw new Error('Session expired');
    const rows = parseOrders(html);
    if (rows.length === 0) break;
    allOrders.push(...rows);
    // Check if there's a next page
    const hasNextPage = html.includes(`page=${page + 1}`);
    if (!hasNextPage) break;
    page++;
  }
  return allOrders;
}

async function getMaukirimOrders() {
  const now = Date.now();
  if (maukirimCache.orders && now < maukirimCache.expiresAt) {
    return maukirimCache.orders;
  }
  if (maukirimCache.pending) {
    return maukirimCache.pending;
  }

  maukirimCache.pending = (async () => {
    try {
      const ck = await loginMaukirim();
      const orders = await fetchAllOrders(ck);
      maukirimCache.orders = orders;
      maukirimCache.expiresAt = Date.now() + MAUKIRIM_CACHE_TTL_MS;
      return orders;
    } finally {
      maukirimCache.pending = null;
    }
  })();

  return maukirimCache.pending;
}

// ── Main handler ─────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (cors(req, res)) return;

  // Route: /api/check-update?action=maukirim&cabang=xxx
  if (isMaukirimRequest(req)) {
    const cabang = (req.query.cabang || '').trim().toUpperCase();
    try {
      const all = await getMaukirimOrders();
      const cabangKey = normalizeCabangName(cabang);
      const filtered = cabangKey
        ? all.filter(o => {
            const orderCabang = normalizeCabangName(o.cabang);
            return orderCabang.includes(cabangKey) || cabangKey.includes(orderCabang);
          })
        : all;
      return res.json({ ok: true, total: filtered.length, orders: filtered });
    } catch (err) {
      console.error('[maukirim]', err.message);
      return res.status(500).json({ error: err.message });
    }
  }

  // Default: count transfers
  try {
    const supabase = getSupabase();
    const { count, error } = await supabase
      .from('transfers')
      .select('id', { count: 'exact', head: true });
    if (error) throw error;
    res.json(count || 0);
  } catch (err) {
    console.error(err);
    logError('check-update', err.message, { method: req.method });
    res.status(500).json(0);
  }
};
