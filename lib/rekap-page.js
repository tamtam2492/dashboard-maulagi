let dataGlobal = {};
let lastRowCount = 0;
let activeFilter = 'semua';
let currentPeriode = '';
let selectedCabang = '';
let filteredCabangData = {};

function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function handleProofLinkClick(event) {
  const proofLink = event.target.closest('a[data-proof-link="1"]');
  if (!proofLink) return;
  event.preventDefault();
  openPic(proofLink.href);
}

function initRekapEventBindings() {
  const filterMap = {
    'fp-semua': 'semua',
    'fp-hari': 'hari',
    'fp-minggu': 'minggu',
  };

  Object.entries(filterMap).forEach(([id, filter]) => {
    const button = document.getElementById(id);
    if (button) button.addEventListener('click', () => setFilter(filter));
  });

  const refreshBtn = document.getElementById('maukirimRefreshBtn');
  if (refreshBtn) refreshBtn.addEventListener('click', loadMaukirimOrders);

  const proofCloseHeadBtn = document.getElementById('proofCloseHeadBtn');
  if (proofCloseHeadBtn) proofCloseHeadBtn.addEventListener('click', closeProofModal);

  const proofRotateBtn = document.getElementById('proofRotateBtn');
  if (proofRotateBtn) proofRotateBtn.addEventListener('click', rotateImg);

  const proofCloseFooterBtn = document.getElementById('proofCloseFooterBtn');
  if (proofCloseFooterBtn) proofCloseFooterBtn.addEventListener('click', closeProofModal);

  const fullImg = document.getElementById('fullImg');
  if (fullImg) {
    fullImg.addEventListener('load', handleProofLoad);
    fullImg.addEventListener('error', handleProofError);
  }

  const detailTransferList = document.getElementById('detailTransferList');
  if (detailTransferList) detailTransferList.addEventListener('click', handleProofLinkClick);
}

initRekapEventBindings();

window.onload = () => {
  const params = new URLSearchParams(location.search);
  selectedCabang = params.get('cabang') || '';
  document.getElementById('hdName').textContent = selectedCabang || 'Rekap Transfer';
  document.title = selectedCabang ? 'Rekap · ' + selectedCabang : 'Rekap Transfer';
  loadDataFromServer();
  setInterval(checkUpdate, 180000);
};

function hideLoading() {
  document.getElementById('loadingScreen').classList.add('hide');
  setTimeout(() => {
    document.getElementById('loadingScreen').style.display = 'none';
    document.getElementById('mainPage').classList.add('show');
  }, 300);
}

function loadDataFromServer() {
  fetch('/api/dashboard')
    .then(r => r.json())
    .then(init)
    .catch(() => {
      hideLoading();
      document.getElementById('errCard').style.display = '';
      document.getElementById('errMsg').textContent = 'Gagal memuat data. Periksa koneksi.';
    });
}

function checkUpdate() {
  fetch('/api/dashboard?update=1')
    .then(r => r.json())
    .then(n => { if (n > lastRowCount) { lastRowCount = n; loadDataFromServer(); } })
    .catch(() => {});
}

function parseTgl(tglStr) {
  if (!tglStr || tglStr === '-') return null;
  const p = tglStr.split('/');
  if (p.length !== 3) return null;
  const yr = parseInt(p[2]);
  const fullYear = yr < 100 ? 2000 + yr : yr;
  return new Date(fullYear, parseInt(p[1]) - 1, parseInt(p[0]));
}

function setFilter(f) {
  activeFilter = f;
  document.querySelectorAll('.filter-pill').forEach(b => b.classList.remove('active'));
  document.getElementById('fp-' + f).classList.add('active');
  renderDetail();
}

function init(d) {
  hideLoading();
  if (d.error) {
    document.getElementById('errCard').style.display = '';
    document.getElementById('errMsg').textContent = d.error;
    return;
  }

  dataGlobal = d;
  lastRowCount = d.transaksi;
  document.getElementById('hdStatus').textContent = 'Update: ' + d.lastUpdate;

  const nowWITA = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Makassar' }));
  currentPeriode = nowWITA.toLocaleDateString('en-CA', { year: 'numeric', month: '2-digit' }).slice(0, 7);

  buildFilteredData();
  document.getElementById('mainContent').style.display = '';
  renderDetail();
}

function buildFilteredData() {
  const nowWITA = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Makassar' }));
  const today = new Date(nowWITA.getFullYear(), nowWITA.getMonth(), nowWITA.getDate());
  filteredCabangData = {};
  for (let c in dataGlobal.byCabang) {
    let list;
    if (activeFilter === 'semua') {
      // Semua = periode bulan ini
      list = dataGlobal.byCabang[c].list.filter(l => l.periode === currentPeriode);
    } else if (activeFilter === 'hari') {
      // Kemarin = berdasarkan tgl_inputan (tanggal pickup)
      const yd = new Date(today); yd.setDate(today.getDate() - 1);
      const ydStr = yd.toLocaleDateString('en-CA');
      list = dataGlobal.byCabang[c].list.filter(l => l.tglRaw === ydStr);
    } else if (activeFilter === 'minggu') {
      // Minggu ini = berdasarkan tgl_inputan (tanggal pickup)
      const sw = new Date(today); sw.setDate(today.getDate() - today.getDay());
      const swStr = sw.toLocaleDateString('en-CA');
      list = dataGlobal.byCabang[c].list.filter(l => l.tglRaw && l.tglRaw >= swStr);
    } else {
      list = dataGlobal.byCabang[c].list.filter(l => l.periode === currentPeriode);
    }
    if (list.length > 0) filteredCabangData[c] = { total: list.reduce((s, l) => s + l.nominal, 0), list };
  }
}

function renderDetail() {
  buildFilteredData();
  const data = filteredCabangData[selectedCabang];
  document.getElementById('selTotal').textContent = data ? 'Rp ' + data.total.toLocaleString('id-ID') : 'Rp 0';
  document.getElementById('selTransaksi').textContent = data ? data.list.length + ' transaksi' : '0 transaksi';

  const listEl = document.getElementById('detailTransferList');
  if (!data || !data.list.length) {
    listEl.innerHTML = '<div class="tr-empty"><i class="bi bi-inbox"></i>Tidak ada transfer pada periode ini</div>';
    return;
  }
  const sorted = [...data.list].sort((a, b) => {
    const da = parseTgl(a.tgl), db = parseTgl(b.tgl);
    if (!da || !db) return 0;
    if (db - da !== 0) return db - da;
    // tiebreaker: gunakan timestamp jika tanggal sama
    return new Date(b.ts || 0) - new Date(a.ts || 0);
  });
  listEl.innerHTML = sorted.map(l => `
    <div class="tr-row">
      <div class="tr-icon"><i class="bi bi-arrow-up-right"></i></div>
      <div class="tr-body">
        <span class="tr-bank">${escHtml(l.bank)}</span>
        <div class="tr-tgl">${escHtml(l.tgl)}${l.ts ? ' · ' + fmtWITA(l.ts) : ''}</div>
        ${l.ket && l.ket !== '-' ? `<div class="tr-ket">${escHtml(l.ket)}</div>` : ''}
        ${l.bukti ? `<a class="btn-bukti-sm" data-proof-link="1" href="${escHtml(l.bukti)}"><i class="bi bi-image"></i> Lihat Bukti</a>` : ''}
      </div>
      <div class="tr-nom">Rp ${l.nominal.toLocaleString('id-ID')}</div>
    </div>`).join('');
}

function fmtWITA(ts) {
  if (!ts) return '';
  try {
    return new Date(ts).toLocaleTimeString('id-ID', { timeZone: 'Asia/Makassar', hour: '2-digit', minute: '2-digit' }) + ' WITA';
  } catch { return ''; }
}

let rotateDeg = 0;

function getModalProofBounds(sideways) {
  const mobile = window.innerWidth < 720;
  if (sideways) {
    return {
      maxWidth: mobile ? '68vh' : '60vh',
      maxHeight: mobile ? '82vw' : '68vw',
    };
  }
  return {
    maxWidth: '100%',
    maxHeight: mobile ? 'min(46vh, 340px)' : 'min(64vh, 520px)',
  };
}

function applyModalProofRotation() {
  const img = document.getElementById('fullImg');
  const normalized = ((rotateDeg % 360) + 360) % 360;
  const sideways = normalized === 90 || normalized === 270;
  const bounds = getModalProofBounds(sideways);
  img.style.transform = `rotate(${rotateDeg}deg)`;
  img.style.maxWidth = bounds.maxWidth;
  img.style.maxHeight = bounds.maxHeight;
}

function handleProofLoad() {
  const img = document.getElementById('fullImg');
  const err = document.getElementById('imgErr');
  img.style.display = '';
  err.style.display = 'none';
  rotateDeg = 0;
  applyModalProofRotation();
}

function handleProofError() {
  document.getElementById('fullImg').style.display = 'none';
  document.getElementById('imgErr').style.display = 'block';
}

function rotateImg() {
  const img = document.getElementById('fullImg');
  if (!img.src) return;
  rotateDeg = (rotateDeg + 90) % 360;
  applyModalProofRotation();
}

function isAllowedProofImageUrl(src) {
  if (!src) return false;
  try {
    const url = new URL(src, window.location.origin);
    if (url.origin === window.location.origin && (url.pathname === '/api/proxy-image' || url.pathname === '/api/image')) {
      return true;
    }
    return /^https:\/\/.*\.supabase\.co\/storage\//.test(url.href);
  } catch {
    return false;
  }
}

function openPic(src) {
  if (!isAllowedProofImageUrl(src)) return false;
  try {
    const modalEl = document.getElementById('modalImg');
    const img = document.getElementById('fullImg');
    const errEl = document.getElementById('imgErr');
    modalEl.classList.add('show');
    modalEl.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
    img.style.display = 'none';
    img.style.transform = '';
    const bounds = getModalProofBounds(false);
    img.style.maxWidth = bounds.maxWidth;
    img.style.maxHeight = bounds.maxHeight;
    rotateDeg = 0;
    errEl.style.display = 'none';
    img.src = src;
    return false;
  } catch {
    return false;
  }
}

function closeProofModal() {
  const modalEl = document.getElementById('modalImg');
  const img = document.getElementById('fullImg');
  const errEl = document.getElementById('imgErr');
  modalEl.classList.remove('show');
  modalEl.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
  img.removeAttribute('src');
  img.style.display = 'none';
  img.style.transform = '';
  errEl.style.display = 'none';
}

document.getElementById('modalImg').addEventListener('click', event => {
  if (event.target && event.target.id === 'modalImg') closeProofModal();
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && document.getElementById('modalImg').classList.contains('show')) {
    closeProofModal();
  }
});
window.addEventListener('resize', () => {
  if (document.getElementById('modalImg').classList.contains('show') && document.getElementById('fullImg').src) {
    applyModalProofRotation();
  }
});

function getMaukirimStatusClass(status) {
  const text = String(status || '').toLowerCase();
  if (text.includes('diterima') || text.includes('selesai')) return 'diterima';
  if (text.includes('antar')) return 'diantar';
  if (text.includes('retur') || text.includes('batal') || text.includes('void')) return 'retur';
  return 'proses';
}

function getMaukirimMethodClass(method) {
  const text = String(method || '').toLowerCase();
  return ['cod', 'dfod', 'noncod'].includes(text) ? text : 'other';
}

// ── Maukirim Orders ──────────────────────────────────────────────────────
async function loadMaukirimOrders() {
  const el = document.getElementById('maukirimList');
  const btn = document.getElementById('maukirimRefreshBtn');
  el.innerHTML = '<div style="text-align:center;padding:20px;color:var(--gray);font-size:0.8rem"><span class="spinner-border spinner-border-sm me-2"></span>Memuat...</div>';
  if (btn) btn.disabled = true;
  try {
    const cabangParam = encodeURIComponent(selectedCabang);
    const r = await fetch(`/api/dashboard?maukirim=1&cabang=${cabangParam}`);
    const d = await r.json();
    if (!d.ok) throw new Error(d.error || 'Gagal memuat');
    if (!d.orders.length) {
      el.innerHTML = '<div style="text-align:center;padding:20px;color:var(--gray);font-size:0.8rem"><i class="bi bi-inbox me-1"></i>Tidak ada order untuk cabang ini</div>';
      return;
    }
    el.innerHTML = d.orders.map(o => {
      const metodeText = String(o.metode || '').toLowerCase();
      const metodeClass = getMaukirimMethodClass(metodeText);
      const statusClass = getMaukirimStatusClass(o.status);
      return `<div class="mk-item">
        <div class="mk-resi">
          <i class="bi bi-box-seam" style="color:#7c3aed"></i>
          <span>${escHtml(o.resi || '-')}</span>
          <span class="mk-metode ${metodeClass}">${escHtml(metodeText ? metodeText.toUpperCase() : '-')}</span>
          <span class="mk-badge ${statusClass}">${escHtml(o.status || '-')}</span>
        </div>
        <div class="mk-meta">
          <span><i class="bi bi-person"></i> ${escHtml(o.penerima || '-')}</span>
          <span><i class="bi bi-truck"></i> ${escHtml(o.ekspedisi || '-')}</span>
          <span><i class="bi bi-calendar3"></i> ${escHtml(o.tanggal || '-')}</span>
          <span><i class="bi bi-currency-exchange"></i> Rp ${escHtml(o.total || '0')}</span>
        </div>
      </div>`;
    }).join('');
  } catch(e) {
    el.innerHTML = `<div style="text-align:center;padding:16px;color:var(--red);font-size:0.8rem"><i class="bi bi-exclamation-circle me-1"></i>${e.message}</div>`;
  } finally {
    if (btn) btn.disabled = false;
  }
}

// Auto-load after main data loaded
setTimeout(loadMaukirimOrders, 1500);
