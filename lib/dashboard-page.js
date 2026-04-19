const SESSION_TIMEOUT = 60 * 60 * 1000;
const REMEMBERED_SESSION_TIMEOUT = 30 * 24 * 60 * 60 * 1000;
const SESSION_STATE_SUFFIXES = ['Auth', 'AuthTs', 'Token', 'AuthRemember', 'Cabang'];
const SESSION_CHECK_INTERVAL = 5000;
const WORKSPACE_MARKER_WATCH_MS = 10000;
let currentTab = 'dashboard';
let lastShipmentTab = 'noncod';
let pendingShellAction = null;
let dashboardAuditState = null;
let bootStarted = false;
let workspaceHeaderObserved = false;
let dashboardAuditSelectedCabang = '';
let dashboardAuditCache = null;
let workspaceRefreshPromise = null;
let workspaceWarmupPromise = null;
let workspaceMarkerWatchId = 0;
let workspaceMarkerWatchBusy = false;
let workspaceMarkerToken = '';
const frameLoadWatches = new Map();
const frameStatusWaiters = new Map();
let dashboardBootWatch = null;

function normalizeWorkspaceCabangKey(value) {
  return String(value || '').trim().toUpperCase();
}

function initDashboardEventBindings() {
  const backBtn = document.getElementById('dashboardBackBtn');
  const statusChip = document.getElementById('statusChip');
  const uploadBtn = document.getElementById('shellUploadBtn');
  const downloadBtn = document.getElementById('shellDownloadBtn');
  const auditDetail = document.getElementById('auditDashboardDetail');
  const latestTransferModal = document.getElementById('latestTransferModal');
  const latestTransferCloseBtn = document.getElementById('latestTransferCloseBtn');
  const auditProofModal = document.getElementById('auditProofModal');
  const auditProofCloseBtn = document.getElementById('auditProofCloseBtn');
  const auditProofCloseFooterBtn = document.getElementById('auditProofCloseFooterBtn');
  const auditProofImg = document.getElementById('auditProofImg');
  const workspaceRefreshBtn = document.getElementById('workspaceRefreshBtn');
  const refreshOverviewBtn = document.getElementById('refreshOverviewBtn');
  const auditRefreshBtn = document.getElementById('auditDashboardRefreshBtn');
  const auditSearch = document.getElementById('auditDashboardSearch');
  const auditList = document.getElementById('auditDashboardList');

  if (backBtn) {
    backBtn.addEventListener('click', logoutWorkspace);
  }
  if (statusChip) {
    statusChip.addEventListener('click', openLatestTransferModal);
  }
  if (uploadBtn) {
    uploadBtn.addEventListener('click', openWorkspaceUpload);
  }
  if (downloadBtn) {
    downloadBtn.addEventListener('click', downloadWorkspaceFile);
  }
  if (latestTransferModal) {
    latestTransferModal.addEventListener('click', handleLatestTransferOverlay);
  }
  if (latestTransferCloseBtn) {
    latestTransferCloseBtn.addEventListener('click', closeLatestTransferModal);
  }
  if (auditProofModal) {
    auditProofModal.addEventListener('click', handleAuditProofOverlay);
  }
  if (auditProofCloseBtn) {
    auditProofCloseBtn.addEventListener('click', closeAuditProofModal);
  }
  if (auditProofCloseFooterBtn) {
    auditProofCloseFooterBtn.addEventListener('click', closeAuditProofModal);
  }
  if (auditProofImg) {
    auditProofImg.addEventListener('load', handleAuditProofLoad);
    auditProofImg.addEventListener('error', handleAuditProofError);
  }
  document.querySelectorAll('.tab-btn[data-tab]').forEach(button => {
    button.addEventListener('click', () => setTab(button.dataset.tab || 'dashboard'));
  });
  if (workspaceRefreshBtn) {
    workspaceRefreshBtn.addEventListener('click', () => requestWorkspaceRefresh({
      source: 'workspace_banner',
      spinOverview: currentTab === 'dashboard',
    }));
  }
  if (refreshOverviewBtn) {
    refreshOverviewBtn.addEventListener('click', () => requestWorkspaceRefresh({
      source: 'dashboard_panel',
      spinOverview: true,
    }));
  }
  if (auditRefreshBtn) {
    auditRefreshBtn.addEventListener('click', () => requestWorkspaceRefresh({
      source: 'audit_panel',
      spinOverview: false,
    }));
  }
  if (auditSearch) {
    auditSearch.addEventListener('input', renderDashboardAuditList);
  }
  if (auditList) {
    auditList.addEventListener('click', event => {
      const button = event.target.closest('.audit-cabang-btn[data-cabang]');
      if (!button) return;
      selectDashboardAuditCabang(button.dataset.cabang || '');
    });
  }
  if (auditDetail) {
    auditDetail.addEventListener('click', event => {
      const proofLink = event.target.closest('.audit-proof-link[data-proof-url]');
      if (!proofLink) return;
      event.preventDefault();
      openAuditProofModal({
        src: proofLink.dataset.proofUrl || proofLink.getAttribute('href') || '',
        label: proofLink.dataset.proofLabel || proofLink.textContent || 'Bukti Transfer',
        context: proofLink.dataset.proofContext || ''
      });
    });
  }
}

function hasActiveSession(prefix) {
  hydrateRememberedSession(prefix);
  const auth = getStoredSessionValue(prefix, 'Auth');
  const ts = parseInt(getStoredSessionValue(prefix, 'AuthTs') || '0', 10);
  if (!auth || !ts) return false;
  if (Date.now() - ts > getSessionTimeout(prefix)) {
    clearStoredSession(prefix);
    return false;
  }
  return true;
}

async function hasWorkspaceServerSession(prefix = getActiveSessionPrefix()) {
  const role = prefix === 'admin' ? 'admin' : prefix === 'viewer' ? 'viewer' : 'dashboard';
  try {
    const res = await fetch('/api/auth?session=1&role=' + encodeURIComponent(role), {
      credentials: 'same-origin'
    });
    if (!res.ok) return false;
    if (role === 'viewer') {
      const json = await res.json().catch(() => null);
      if (json && json.cabang) {
        setViewerCabangSession(json.cabang);
      }
    }
    return true;
  } catch {
    return null;
  }
}

function getStoredSessionValue(prefix, suffix) {
  const sessionValue = sessionStorage.getItem(prefix + suffix);
  if (sessionValue !== null) return sessionValue;
  const localValue = localStorage.getItem(prefix + suffix);
  return localValue !== null ? localValue : '';
}

function clearStoredSession(prefix) {
  SESSION_STATE_SUFFIXES.forEach((suffix) => {
    sessionStorage.removeItem(prefix + suffix);
    localStorage.removeItem(prefix + suffix);
  });
}

function hydrateRememberedSession(prefix) {
  if (sessionStorage.getItem(prefix + 'Auth') !== null) return;
  if (localStorage.getItem(prefix + 'AuthRemember') !== '1') return;

  const auth = localStorage.getItem(prefix + 'Auth');
    chip.textContent = '';
  if (!auth || !ts || (Date.now() - ts > REMEMBERED_SESSION_TIMEOUT)) {
    clearStoredSession(prefix);
    return;
    chip.style.display = 'none';
  }

  chip.style.display = '';
  SESSION_STATE_SUFFIXES.forEach((suffix) => {
    const value = localStorage.getItem(prefix + suffix);
    if (value !== null) sessionStorage.setItem(prefix + suffix, value);
  });
}

function getSessionTimeout(prefix) {
  return getStoredSessionValue(prefix, 'AuthRemember') === '1'
    ? REMEMBERED_SESSION_TIMEOUT
    : SESSION_TIMEOUT;
}
function setViewerCabangSession(cabang) {
  const nextCabang = cabang || '';
  sessionStorage.setItem('viewerCabang', nextCabang);
  if (getStoredSessionValue('viewer', 'AuthRemember') === '1') {
    localStorage.setItem('viewerCabang', nextCabang);
  }
}

function getActiveSessionPrefix() {
  if (hasActiveSession('admin')) return 'admin';
  if (hasActiveSession('dash')) return 'dash';
  if (hasActiveSession('viewer')) return 'viewer';
  return '';
}

function clearConflictingViewerSessions() {
  clearStoredSession('admin');
  clearStoredSession('dash');
}

function clearConflictingAdminSessions() {
  clearStoredSession('viewer');
  clearStoredSession('dash');
}

function setSessionTs(prefix = getActiveSessionPrefix()) {
  if (!prefix) return;
  const nextValue = String(Date.now());
  sessionStorage.setItem(prefix + 'AuthTs', nextValue);
  if (getStoredSessionValue(prefix, 'AuthRemember') === '1') {
    localStorage.setItem(prefix + 'AuthTs', nextValue);
  }
}

function isSessionExpired(prefix = getActiveSessionPrefix()) {
  return !prefix || !hasActiveSession(prefix);
}

function isAdminWorkspace() {
  return getActiveSessionPrefix() === 'admin';
}

function isViewerWorkspace() {
  return getActiveSessionPrefix() === 'viewer';
}

function applyWorkspaceRoleUi() {
  const adminMode = isAdminWorkspace();
  const viewerMode = isViewerWorkspace();
  const writeMode = adminMode; // viewer dan dashboard sama-sama read-only untuk upload
  const auditSearch = document.getElementById('auditDashboardSearch');
  const auditShell = document.querySelector('.audit-shell');
  const overviewGrid = document.getElementById('overviewGrid');
  const branchesCard = document.getElementById('ovBranchesCard');
  const statusChip = document.getElementById('statusChip');
  document.getElementById('shellUploadBtn').style.display = writeMode ? '' : 'none';
  document.getElementById('tab-admin').style.display = adminMode ? '' : 'none';
  document.getElementById('panel-admin').style.display = adminMode ? '' : 'none';

  if (auditShell) {
    auditShell.classList.toggle('viewer-locked', viewerMode);
  }

  if (overviewGrid) {
    overviewGrid.classList.toggle('viewer-compact', viewerMode);
  }

  if (branchesCard) {
    branchesCard.style.display = viewerMode ? 'none' : '';
  }

  if (auditSearch) {
    auditSearch.disabled = viewerMode;
    auditSearch.placeholder = viewerMode ? 'Audit otomatis untuk cabang login' : 'Ketik nama cabang';
    if (viewerMode) auditSearch.value = '';
  }

  if (statusChip && !latestTransferDetail) {
    statusChip.style.display = 'none';
  }

  if (viewerMode) {
    const cabang = getStoredSessionValue('viewer', 'Cabang') || '';
    const badge = document.getElementById('viewerCabangBadge');
    const badgeText = document.getElementById('viewerCabangBadgeText');
    if (badge) { badge.style.display = cabang ? '' : 'none'; }
    if (badgeText) badgeText.textContent = cabang;
  }
}

function clearWorkspaceSessions() {
  clearStoredSession('dash');
  clearStoredSession('admin');
  clearStoredSession('viewer');
}

async function invalidateServerSession() {
  try {
    await fetch('/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      keepalive: true,
      body: JSON.stringify({ action: 'logout' })
    });
  } catch {}
}

function syncWorkspaceStickyOffset() {
  const header = document.querySelector('.shell-header');
  if (!header) return;
  const nextOffset = Math.max(0, Math.ceil(header.getBoundingClientRect().height || header.offsetHeight || 0));
  if (!nextOffset) return;
  document.documentElement.style.setProperty('--workspace-sticky-offset', nextOffset + 'px');
}

function observeWorkspaceHeader() {
  if (workspaceHeaderObserved) return;
  workspaceHeaderObserved = true;
  const header = document.querySelector('.shell-header');
  if (!header) return;
  syncWorkspaceStickyOffset();
  if ('ResizeObserver' in window) {
    const observer = new ResizeObserver(() => syncWorkspaceStickyOffset());
    observer.observe(header);
  }
  window.addEventListener('resize', syncWorkspaceStickyOffset);
}

async function doLogout() {
  clearWorkspaceSessions();
  await invalidateServerSession();
  location.replace('/');
}

async function logoutWorkspace(event) {
  event.preventDefault();
  await doLogout();
}

setInterval(() => {
  const prefix = getActiveSessionPrefix();
  if (prefix && isSessionExpired(prefix)) doLogout();
}, SESSION_CHECK_INTERVAL);

function hideLoading() {
  document.getElementById('loadingScreen').classList.add('hide');
  setTimeout(() => {
    document.getElementById('loadingScreen').style.display = 'none';
    document.getElementById('app').classList.add('show');
    syncWorkspaceStickyOffset();
  }, 250);
}

function getCurrentPeriode() {
  return new Date().toLocaleDateString('en-CA', {
    timeZone: 'Asia/Makassar',
    year: 'numeric',
    month: '2-digit'
  }).slice(0, 7);
}

function getPeriodeLabel(periode) {
  const bulan = ['Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'];
  const parts = String(periode || '').split('-');
  if (parts.length !== 2) return periode || '-';
  const idx = parseInt(parts[1], 10) - 1;
  return (bulan[idx] || '-') + ' ' + parts[0];
}

function getPeriodeShortLabel(periode) {
  const bulan = ['JAN','FEB','MAR','APR','MEI','JUN','JUL','AGU','SEP','OKT','NOV','DES'];
  const parts = String(periode || '').split('-');
  if (parts.length !== 2) return String(periode || '-').toUpperCase();
  const idx = parseInt(parts[1], 10) - 1;
  return (bulan[idx] || '-') + ' ' + parts[0];
}

function getRecentPeriodes(count, endPeriode = getCurrentPeriode()) {
  const parts = String(endPeriode || '').split('-');
  const year = parseInt(parts[0], 10);
  const month = parseInt(parts[1], 10);
  if (!year || !month) return [endPeriode];
  const pad = value => String(value).padStart(2, '0');
  const periods = [];
  for (let offset = count - 1; offset >= 0; offset--) {
    const dt = new Date(year, month - 1 - offset, 1);
    periods.push(dt.getFullYear() + '-' + pad(dt.getMonth() + 1));
  }
  return periods;
}

function createMetric() {
  return { grandOngkir: 0, grandTotal: 0, totalResi: 0, cabangCount: 0 };
}

function createSummaryGroup() {
  return { noncod: createMetric(), dfod: createMetric(), all: createMetric() };
}

function fmtNominal(value) {
  return 'Rp ' + Number(value || 0).toLocaleString('id-ID');
}

function fmtNominalCompact(value) {
  const amount = Number(value || 0);
  const absAmount = Math.abs(amount);
  if (absAmount >= 1000000000) {
    return 'Rp ' + (amount / 1000000000).toLocaleString('id-ID', { maximumFractionDigits: 1 }) + ' M';
  }
  if (absAmount >= 1000000) {
    return 'Rp ' + (amount / 1000000).toLocaleString('id-ID', { maximumFractionDigits: 1 }) + ' jt';
  }
  if (absAmount >= 1000) {
    return 'Rp ' + (amount / 1000).toLocaleString('id-ID', { maximumFractionDigits: 1 }) + ' rb';
  }
  return 'Rp ' + amount.toLocaleString('id-ID');
}

function fmtCount(value) {
  return Number(value || 0).toLocaleString('id-ID');
}

function getSyncStampLabel(syncInfo) {
  if (!syncInfo || !syncInfo.syncedAt) return '';
  try {
    const syncDate = new Date(syncInfo.syncedAt);
    const dateLabel = syncDate.toLocaleDateString('id-ID', {
      timeZone: 'Asia/Makassar',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric'
    });
    const timeLabel = syncDate.toLocaleTimeString('id-ID', {
      timeZone: 'Asia/Makassar',
      hour: '2-digit',
      minute: '2-digit'
    }) + ' WITA';
    return dateLabel + ' · ' + timeLabel;
  } catch {
    return '';
  }
}

function getWorkspaceSnapshotStatus(periode, syncInfo) {
  const baseLabel = 'Periode aktif: ' + getPeriodeLabel(periode);
  if (!syncInfo) return baseLabel + ' · Status sinkron belum tersedia';
  if (syncInfo.error) return baseLabel + ' · Status sinkron bermasalah';

  if (syncInfo.refreshState && syncInfo.refreshState.status === 'running' && syncInfo.refreshState.action !== 'inline') {
    return baseLabel + ' · Snapshot sedang disegarkan';
  }
  if (syncInfo.refreshState && syncInfo.refreshState.status === 'queued') {
    return baseLabel + ' · Snapshot dijadwalkan refresh';
  }

  const syncStamp = getSyncStampLabel(syncInfo);
  if (syncStamp) return baseLabel + ' · Snapshot ' + syncStamp;

  const pipelineStamp = syncInfo.pipeline && syncInfo.pipeline.lastPublishedAt
    ? getSyncStampLabel({ syncedAt: syncInfo.pipeline.lastPublishedAt })
    : '';
  if (pipelineStamp) return baseLabel + ' · Publish ' + pipelineStamp;

  if (!syncInfo.enabled) return baseLabel + ' · Auto-sync belum aktif';
  if (!syncInfo.eligible) return baseLabel + ' · Data periode tersimpan';
  return baseLabel + ' · Snapshot tersimpan';
}

function updateWorkspaceSyncBanner(syncInfo) {
  const banner = document.getElementById('workspaceSyncBanner');
  const main = document.getElementById('workspaceSyncMain');
  const sub = document.getElementById('workspaceSyncSub');
  if (!banner || !main || !sub) return;

  function setMainStatus(iconClass, text) {
    main.innerHTML = '<i class="bi ' + iconClass + ' workspace-sync-main-icon" aria-hidden="true"></i><span>' + text + '</span>';
  }

  if (!syncInfo) {
    banner.dataset.tone = 'warn';
    setMainStatus('bi-arrow-repeat', 'Status sinkron belum tersedia');
    sub.style.display = '';
    sub.textContent = 'Tunggu overview selesai dimuat.';
    return;
  }

  sub.style.display = '';
  const syncStamp = getSyncStampLabel(syncInfo);
  const stats = syncInfo.stats || {};
  const statParts = [];
  if (stats.noncod != null) statParts.push('NONCOD ' + fmtCount(stats.noncod) + ' resi');
  if (stats.dfod != null) statParts.push('DFOD ' + fmtCount(stats.dfod) + ' resi');
  const statsText = statParts.length ? statParts.join(' · ') : 'Status resi tidak tersedia';

  if (syncInfo.error) {
    banner.dataset.tone = 'error';
    setMainStatus('bi-exclamation-circle', 'Sync MauKirim gagal, memakai data terakhir');
    sub.textContent = statsText;
    return;
  }
  if (!syncInfo.enabled) {
    banner.dataset.tone = 'warn';
    setMainStatus('bi-pause-circle', 'Auto-sync MauKirim belum aktif');
    sub.textContent = 'Isi MAUKIRIM_WA dan MAUKIRIM_PASS di environment.';
    return;
  }
  if (!syncInfo.eligible) {
    banner.dataset.tone = 'warn';
    setMainStatus('bi-arrow-repeat', 'Data periode tersimpan');
    sub.textContent = statsText;
    return;
  }
  if (syncInfo.refreshState && syncInfo.refreshState.status === 'running' && syncInfo.refreshState.action !== 'inline') {
    banner.dataset.tone = 'warn';
    setMainStatus('bi-arrow-repeat', 'Snapshot sedang disegarkan otomatis');
    sub.textContent = (syncStamp ? 'Snapshot terakhir ' + syncStamp + ' · ' : '') + statsText;
    return;
  }
  if (syncInfo.refreshState && syncInfo.refreshState.status === 'queued') {
    banner.dataset.tone = 'warn';
    setMainStatus('bi-hourglass-split', 'Snapshot dijadwalkan refresh otomatis');
    sub.textContent = (syncStamp ? 'Snapshot terakhir ' + syncStamp + ' · ' : '') + statsText;
    return;
  }
  if (syncInfo.source === 'manual_upload') {
    banner.dataset.tone = 'warn';
    setMainStatus('bi-arrow-repeat', 'Data shipment tersimpan sebelumnya');
    sub.textContent = (syncStamp ? 'Terakhir sync ' + syncStamp + ' · ' : '') + statsText;
    return;
  }

  banner.dataset.tone = syncInfo.performed ? 'ok' : 'warn';
  if (syncInfo.performed) {
    setMainStatus('bi-arrow-clockwise', 'Baru sinkron dari MauKirim');
    sub.textContent = (syncStamp ? 'Waktu sync ' + syncStamp + ' · ' : '') + statsText;
    return;
  }

  setMainStatus('bi-arrow-repeat', syncStamp ? 'Terakhir sync ' + syncStamp : 'Snapshot tersimpan');
  sub.textContent = '';
  sub.style.display = 'none';
}

let latestTransferDetail = null;

function setTrendHeading(title) {
  const titleEl = document.getElementById('trendTitle');
  if (titleEl) titleEl.textContent = title;
}

function setLatestTransferChip(detail) {
  latestTransferDetail = detail || null;
  const chip = document.getElementById('statusChip');
  if (!chip) return;
  if (!detail) {
    chip.textContent = '';
    chip.disabled = true;
    chip.classList.remove('clickable');
    chip.title = '';
    chip.style.display = 'none';
    return;
  }
  chip.style.display = '';
  chip.textContent = 'Transfer terakhir ' + (detail.jam || '-');
  chip.disabled = false;
  chip.classList.add('clickable');
  chip.title = 'Klik untuk lihat detail transfer terakhir';
}

function isQuickModalOpen(id) {
  const modal = document.getElementById(id);
  return !!(modal && modal.classList.contains('show'));
}

function syncWorkspaceModalOverflow() {
  document.body.style.overflow = isQuickModalOpen('latestTransferModal') || isQuickModalOpen('auditProofModal') ? 'hidden' : '';
}

function openLatestTransferModal() {
  if (!latestTransferDetail) return;
  document.getElementById('latestTransferTime').textContent = latestTransferDetail.jam || '-';
  document.getElementById('latestTransferCabang').textContent = latestTransferDetail.cabang || '-';
  document.getElementById('latestTransferBank').textContent = latestTransferDetail.bank || '-';
  document.getElementById('latestTransferNominal').textContent = fmtNominal(latestTransferDetail.nominal || 0);
  const proofImg = document.getElementById('latestTransferProofImg');
  const proofEmpty = document.getElementById('latestTransferProofEmpty');
  const hasProof = !!latestTransferDetail.bukti;
  if (hasProof) {
    proofImg.src = latestTransferDetail.bukti;
    proofImg.style.display = 'block';
    proofEmpty.style.display = 'none';
  } else {
    proofImg.removeAttribute('src');
    proofImg.style.display = 'none';
    proofEmpty.style.display = 'block';
  }
  document.getElementById('latestTransferModal').classList.add('show');
  syncWorkspaceModalOverflow();
}

function closeLatestTransferModal() {
  document.getElementById('latestTransferModal').classList.remove('show');
  document.getElementById('latestTransferProofImg').removeAttribute('src');
  document.getElementById('latestTransferProofImg').style.display = 'none';
  document.getElementById('latestTransferProofEmpty').style.display = 'block';
  syncWorkspaceModalOverflow();
}

function handleLatestTransferOverlay(event) {
  if (event.target && event.target.id === 'latestTransferModal') closeLatestTransferModal();
}

function openAuditProofModal(detail) {
  const src = detail && detail.src ? String(detail.src) : '';
  if (!src) return;
  const labelEl = document.getElementById('auditProofLabel');
  const badgeEl = document.getElementById('auditProofBadge');
  const subEl = document.getElementById('auditProofSub');
  const img = document.getElementById('auditProofImg');
  const empty = document.getElementById('auditProofEmpty');
  if (!img || !empty) return;

  if (labelEl) labelEl.textContent = detail.label || 'Bukti Transfer';
  if (badgeEl) badgeEl.textContent = 'Popup';
  if (subEl) subEl.textContent = detail.context || 'Preview bukti pembayaran pada popup ini.';
  empty.textContent = 'Memuat bukti transfer...';
  empty.style.display = 'block';
  img.style.display = 'none';
  img.src = src;
  document.getElementById('auditProofModal').classList.add('show');
  syncWorkspaceModalOverflow();
}

function closeAuditProofModal() {
  const modal = document.getElementById('auditProofModal');
  const img = document.getElementById('auditProofImg');
  const empty = document.getElementById('auditProofEmpty');
  if (modal) modal.classList.remove('show');
  if (img) {
    img.removeAttribute('src');
    img.style.display = 'none';
  }
  if (empty) {
    empty.textContent = 'Memuat bukti transfer...';
    empty.style.display = 'block';
  }
  syncWorkspaceModalOverflow();
}

function handleAuditProofOverlay(event) {
  if (event.target && event.target.id === 'auditProofModal') closeAuditProofModal();
}

function handleAuditProofLoad() {
  const img = document.getElementById('auditProofImg');
  const empty = document.getElementById('auditProofEmpty');
  if (img) img.style.display = 'block';
  if (empty) empty.style.display = 'none';
}

function handleAuditProofError() {
  const img = document.getElementById('auditProofImg');
  const empty = document.getElementById('auditProofEmpty');
  if (img) img.style.display = 'none';
  if (empty) {
    empty.textContent = 'Gambar bukti tidak dapat ditampilkan.';
    empty.style.display = 'block';
  }
}

function setDefaultTrendHeading() {
  const periode = getCurrentPeriode();
  const [prevPeriode] = getRecentPeriodes(2, periode);
  setTrendHeading('Perbandingan Harian MTD · ' + getPeriodeLabel(prevPeriode) + ' vs ' + getPeriodeLabel(periode));
}

function buildTrendAreaPath(points, baselineY) {
  if (!points.length) return '';
  return 'M' + points[0].x.toFixed(2) + ' ' + baselineY.toFixed(2) + ' ' +
    points.map(point => 'L' + point.x.toFixed(2) + ' ' + point.y.toFixed(2)).join(' ') + ' ' +
    'L' + points[points.length - 1].x.toFixed(2) + ' ' + baselineY.toFixed(2) + ' Z';
}

function smoothPath(coords) {
  if (coords.length < 2) return coords.map((p,i) => (i===0?'M':'L')+p.x.toFixed(2)+' '+p.y.toFixed(2)).join(' ');
  if (coords.length === 2) return 'M'+coords[0].x.toFixed(2)+' '+coords[0].y.toFixed(2)+' L'+coords[1].x.toFixed(2)+' '+coords[1].y.toFixed(2);
  const t = 0.35;
  let d = 'M'+coords[0].x.toFixed(2)+' '+coords[0].y.toFixed(2);
  for (let i = 0; i < coords.length - 1; i++) {
    const p0 = coords[Math.max(i-1,0)];
    const p1 = coords[i];
    const p2 = coords[i+1];
    const p3 = coords[Math.min(i+2, coords.length-1)];
    const cp1x = p1.x + (p2.x - p0.x) * t;
    const cp1y = p1.y + (p2.y - p0.y) * t;
    const cp2x = p2.x - (p3.x - p1.x) * t;
    const cp2y = p2.y - (p3.y - p1.y) * t;
    d += ' C'+cp1x.toFixed(2)+','+cp1y.toFixed(2)+' '+cp2x.toFixed(2)+','+cp2y.toFixed(2)+' '+p2.x.toFixed(2)+','+p2.y.toFixed(2);
  }
  return d;
}

function smoothAreaPath(coords, baselineY) {
  if (!coords.length) return '';
  const linePath = smoothPath(coords);
  return linePath + ' L'+coords[coords.length-1].x.toFixed(2)+' '+baselineY.toFixed(2)+' L'+coords[0].x.toFixed(2)+' '+baselineY.toFixed(2)+' Z';
}

function escHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDelta(current, previous) {
  const now = Number(current || 0);
  const prev = Number(previous || 0);
  if (!prev && !now) return { text: 'Stabil 0%', cls: 'flat' };
  if (!prev) return { text: 'Naik +100%', cls: 'up' };
  const pct = ((now - prev) / prev) * 100;
  if (Math.abs(pct) < 0.05) return { text: 'Stabil 0%', cls: 'flat' };
  const sign = pct > 0 ? '+' : '';
  return {
    text: (pct > 0 ? 'Naik ' : 'Turun ') + sign + pct.toLocaleString('id-ID', { maximumFractionDigits: 1 }) + '%',
    cls: pct > 0 ? 'up' : 'down'
  };
}

function getMaxDailyDay(dayMap) {
  return Math.max(0, ...Object.keys(dayMap || {}).map(key => parseInt(key, 10) || 0));
}

function extractDailyTotals(byDay, periode) {
  const prefix = String(periode || '') + '-';
  const result = {};
  Object.keys(byDay || {}).forEach(day => {
    if (!String(day).startsWith(prefix)) return;
    const dayNum = parseInt(String(day).slice(8, 10), 10);
    if (!dayNum) return;
    const totals = Object.values(byDay[day] || {}).reduce((acc, item) => {
      acc.ongkir += Number(item.ongkir || 0);
      acc.total += Number(item.total || 0);
      acc.resi += Number(item.resi || 0);
      return acc;
    }, { ongkir: 0, total: 0, resi: 0 });
    result[dayNum] = totals;
  });
  return result;
}

function hasDailyRows(dayMap) {
  return Object.keys(dayMap || {}).length > 0;
}

function sumDailyMetric(dayMap, metric) {
  return Object.values(dayMap || {}).reduce((sum, item) => sum + Number((item && item[metric]) || 0), 0);
}

function getMtdRangeLabel(dayLimit) {
  if (!dayLimit) return 'MTD';
  return 'MTD Hari 1-' + dayLimit;
}

function getPeakDailyPoint(values, dayLabels) {
  const numbers = (values || []).map(value => Number(value || 0));
  const maxValue = Math.max(0, ...numbers);
  if (!maxValue) return { day: '-', value: 0 };
  const index = numbers.indexOf(maxValue);
  return { day: dayLabels[index] || '-', value: maxValue };
}

function mergeDailyMetric(dayMapA, dayMapB, metric) {
  const keys = new Set([...Object.keys(dayMapA || {}), ...Object.keys(dayMapB || {})]);
  const merged = {};
  keys.forEach(key => {
    merged[key] = Number((dayMapA[key] && dayMapA[key][metric]) || 0) + Number((dayMapB[key] && dayMapB[key][metric]) || 0);
  });
  return merged;
}

async function fetchShipmentModeDataset(periode, mode) {
  try {
    const res = await fetch('/api/noncod?periode=' + encodeURIComponent(periode) + '&mode=' + encodeURIComponent(mode));
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || ('Gagal memuat ' + mode + ' ' + periode));
    return { periode, mode, byDay: json.byDay || {}, monthSummary: json.monthSummary || createSummaryGroup(), syncInfo: json.syncInfo || null };
  } catch (err) {
    return { periode, mode, byDay: {}, monthSummary: createSummaryGroup(), syncInfo: { error: err.message }, error: err.message };
  }
}

function toAuditNominal(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
}

function normalizeAuditDate(value) {
  return String(value || '').slice(0, 10);
}

function getDashboardAuditDates(periode) {
  const parts = String(periode || '').split('-');
  const year = parseInt(parts[0], 10);
  const month = parseInt(parts[1], 10);
  if (!year || !month) return [];
  const maxDay = new Date(year, month, 0).getDate();
  return Array.from({ length: maxDay }, (_, index) => {
    return periode + '-' + String(index + 1).padStart(2, '0');
  });
}

function formatAuditNominal(value) {
  return toAuditNominal(value).toLocaleString('id-ID');
}

function formatAuditDateShort(ymd) {
  if (!ymd) return '-';
  const parts = String(ymd).split('-');
  if (parts.length < 3) return ymd;
  return parts[2] + '/' + parts[1];
}

function formatAuditTime(timestamp) {
  if (!timestamp) return '';
  try {
    return new Date(timestamp).toLocaleTimeString('id-ID', {
      timeZone: 'Asia/Makassar',
      hour: '2-digit',
      minute: '2-digit'
    });
  } catch {
    return '';
  }
}

function getDashboardAuditProofUrl(transfer) {
  const raw = String((transfer && (transfer.bukti || transfer.bukti_url)) || '').trim();
  if (!raw) return '';
  if (raw.startsWith('/api/proxy-image')) return raw;
  if (/^https?:\/\//.test(raw)) {
    const match = raw.match(/\/bukti-transfer\/([^?]+)/);
    if (match) return '/api/proxy-image?path=' + encodeURIComponent(match[1]);
    return raw;
  }
  return '/api/proxy-image?path=' + encodeURIComponent(raw);
}

function buildAuditTransferBreakdown(transfers) {
  if (!Array.isArray(transfers) || !transfers.length) return 'tidak ada transfer';
  return transfers.map(item => formatAuditNominal(item.nominal)).join(' + ');
}

function buildDashboardAuditState(periode, ncData, dashData, cabangRows) {
  const ncByDay = ncData && ncData.byDay ? ncData.byDay : {};
  const dashByCabang = dashData && dashData.byCabang ? dashData.byCabang : {};
  const auditDates = getDashboardAuditDates(periode);
  const cabangMap = new Map();
  const viewerCabangKey = isViewerWorkspace()
    ? normalizeWorkspaceCabangKey(getStoredSessionValue('viewer', 'Cabang'))
    : '';

  function ensureCabangEntry(rawName, rawArea) {
    const cabang = String(rawName || '').trim();
    if (!cabang) return null;
    const area = String(rawArea || 'LAINNYA').trim() || 'LAINNYA';
    if (!cabangMap.has(cabang)) {
      cabangMap.set(cabang, { cabang, area, ncByDate: {}, trByDate: {} });
    } else if (area && cabangMap.get(cabang).area === 'LAINNYA') {
      cabangMap.get(cabang).area = area;
    }
    return cabangMap.get(cabang);
  }

  (Array.isArray(cabangRows) ? cabangRows : []).forEach(row => {
    ensureCabangEntry(row.nama, row.area);
  });

  Object.keys(ncByDay).forEach(date => {
    if (!String(date).startsWith(periode + '-')) return;
    const byCabang = ncByDay[date] || {};
    Object.keys(byCabang).forEach(cabang => {
      const nominal = toAuditNominal(byCabang[cabang] && byCabang[cabang].ongkir);
      const entry = ensureCabangEntry(cabang, 'LAINNYA');
      if (!entry) return;
      entry.ncByDate[date] = nominal;
    });
  });

  Object.keys(dashByCabang).forEach(cabang => {
    const entry = ensureCabangEntry(cabang, 'LAINNYA');
    if (!entry) return;
    const transferList = Array.isArray(dashByCabang[cabang] && dashByCabang[cabang].list)
      ? dashByCabang[cabang].list
      : [];

    transferList.forEach(item => {
      const date = normalizeAuditDate(item.tglRaw);
      if (!date || !String(date).startsWith(periode + '-')) return;
      if (!entry.trByDate[date]) entry.trByDate[date] = [];
      entry.trByDate[date].push({
        nominal: toAuditNominal(item.nominal),
        nama_bank: item.bank || '',
        ket: item.ket || '',
        timestamp: item.ts || '',
        proofUrl: getDashboardAuditProofUrl(item),
      });
    });
  });

  const items = Array.from(cabangMap.values()).map(entry => {
    const orderedDates = [...new Set([...auditDates, ...Object.keys(entry.ncByDate), ...Object.keys(entry.trByDate)])].sort();
    const rows = orderedDates.map(date => {
      const noncod = toAuditNominal(entry.ncByDate[date] || 0);
      const transfers = (entry.trByDate[date] || []).slice().sort((a, b) => new Date(a.timestamp || 0) - new Date(b.timestamp || 0));
      const transfer = transfers.reduce((sum, item) => sum + toAuditNominal(item.nominal), 0);
      const transferText = buildAuditTransferBreakdown(transfers);
      const diff = noncod - transfer;
      const isSafe = noncod > 0 && (diff === 0 || (diff < 0 && Math.abs(diff) <= 500));
      let tone = 'safe';
      let line = '';

      if (noncod <= 0 && transfer <= 0) {
        line = formatAuditDateShort(date) + ': tidak ada NONCOD, tidak ada transfer';
        tone = 'safe';
      } else if (noncod > 0 && transfer <= 0) {
        line = formatAuditDateShort(date) + ': NONCOD ' + formatAuditNominal(noncod) + ', tidak ada transfer';
        tone = 'pending';
      } else if (noncod <= 0 && transfer > 0) {
        line = formatAuditDateShort(date) + ': tidak ada NONCOD, transfer ' + transferText + ', cek';
        tone = 'warn';
      } else if (isSafe) {
        line = formatAuditDateShort(date) + ': NONCOD ' + formatAuditNominal(noncod) + ', transfer ' + transferText + ', aman';
        tone = 'safe';
      } else if (diff > 0) {
        line = formatAuditDateShort(date) + ': NONCOD ' + formatAuditNominal(noncod) + ', transfer ' + transferText + ', kurang ' + formatAuditNominal(diff);
        tone = 'pending';
      } else {
        line = formatAuditDateShort(date) + ': NONCOD ' + formatAuditNominal(noncod) + ', transfer ' + transferText + ', lebih ' + formatAuditNominal(Math.abs(diff));
        tone = 'warn';
      }

      const proofCount = transfers.filter(item => item.proofUrl).length;
      const transferMeta = transfers.map(item => {
        const bank = String(item.nama_bank || '').trim();
        const time = formatAuditTime(item.timestamp);
        const ket = String(item.ket || '').trim();
        return [bank, time, ket].filter(Boolean).join(' · ');
      }).filter(Boolean);

      return { date, noncod, transfer, diff, tone, line, transfers, proofCount, transferMeta };
    });

    const summary = rows.reduce((acc, row) => {
      if (row.noncod > 0 || row.transfer > 0) acc.activeDays += 1;
      if (row.tone === 'safe' && (row.noncod > 0 || row.transfer > 0)) acc.safe += 1;
      if (row.tone === 'pending') acc.pending += 1;
      if (row.tone === 'warn') acc.warn += 1;
      acc.proof += row.proofCount;
      return acc;
    }, { safe: 0, pending: 0, warn: 0, activeDays: 0, proof: 0 });

    return { cabang: entry.cabang, area: entry.area, rows, summary };
  }).filter(item => {
    if (!viewerCabangKey) return true;
    return normalizeWorkspaceCabangKey(item.cabang) === viewerCabangKey;
  }).sort((a, b) => a.cabang.localeCompare(b.cabang, 'id'));

  return { periode, items };
}

function getDashboardAuditItems() {
  return dashboardAuditState && Array.isArray(dashboardAuditState.items) ? dashboardAuditState.items : [];
}

function renderDashboardAuditList() {
  const listEl = document.getElementById('auditDashboardList');
  const detailEl = document.getElementById('auditDashboardDetail');
  const countEl = document.getElementById('auditDashboardCount');
  const searchEl = document.getElementById('auditDashboardSearch');
  const items = getDashboardAuditItems();
  const query = String(searchEl && searchEl.value || '').trim().toLowerCase();

  if (!items.length) {
    if (countEl) countEl.textContent = 'Belum ada audit cabang untuk periode aktif.';
    if (listEl) listEl.innerHTML = '<div class="empty-note">Belum ada data audit cabang.</div>';
    if (detailEl) detailEl.innerHTML = '<div class="empty-note">Belum ada detail audit untuk ditampilkan.</div>';
    return;
  }

  const filtered = items.filter(item => item.cabang.toLowerCase().includes(query));
  if (!filtered.length) {
    if (countEl) countEl.textContent = '0 dari ' + items.length + ' cabang cocok dengan pencarian.';
    if (listEl) listEl.innerHTML = '<div class="empty-note">Cabang tidak ditemukan. Ubah kata kunci pencarian.</div>';
    if (detailEl) detailEl.innerHTML = '<div class="empty-note">Tidak ada cabang yang cocok dengan pencarian saat ini.</div>';
    return;
  }

  if (!filtered.some(item => item.cabang === dashboardAuditSelectedCabang)) {
    dashboardAuditSelectedCabang = filtered[0].cabang;
  }

  const totalIssues = filtered.reduce((sum, item) => sum + item.summary.pending + item.summary.warn, 0);
  if (countEl) {
    countEl.textContent = filtered.length + ' cabang · ' + totalIssues + ' titik perlu dicek · periode ' + getPeriodeLabel(dashboardAuditState.periode);
  }

  if (listEl) {
    listEl.innerHTML = '<div class="audit-list">' + filtered.map(item => {
      const issueText = item.summary.pending > 0 || item.summary.warn > 0
        ? '<span class="audit-cabang-alert">' + (item.summary.pending + item.summary.warn) + ' hari perlu dicek</span>'
        : 'Semua hari aktif aman';
      return '<button class="audit-cabang-btn' + (item.cabang === dashboardAuditSelectedCabang ? ' active' : '') + '" type="button" data-cabang="' + escHtml(item.cabang) + '">' +
        '<div class="audit-cabang-top">' +
          '<div class="audit-cabang-name">' + escHtml(item.cabang) + '</div>' +
          '<div class="audit-cabang-area">' + escHtml(item.area || 'LAINNYA') + '</div>' +
        '</div>' +
        '<div class="audit-cabang-meta">Aktif ' + item.summary.activeDays + ' hari · Aman ' + item.summary.safe + ' · Kurang ' + item.summary.pending + ' · Lebih ' + item.summary.warn + '</div>' +
        '<div class="audit-cabang-meta">' + issueText + '</div>' +
      '</button>';
    }).join('') + '</div>';
  }

  renderDashboardAuditDetail();
}

function selectDashboardAuditCabang(cabang) {
  dashboardAuditSelectedCabang = String(cabang || '');
  renderDashboardAuditList();
}

function renderDashboardAuditDetail() {
  const detailEl = document.getElementById('auditDashboardDetail');
  const items = getDashboardAuditItems();
  const selected = items.find(item => item.cabang === dashboardAuditSelectedCabang) || items[0];

  if (!detailEl) return;
  if (!selected) {
    detailEl.innerHTML = '<div class="empty-note">Pilih cabang untuk melihat audit hariannya.</div>';
    return;
  }

  dashboardAuditSelectedCabang = selected.cabang;
  const summary = selected.summary || { safe: 0, pending: 0, warn: 0, proof: 0, activeDays: 0 };
  const activeRows = selected.rows.filter(row => row.noncod > 0 || row.transfer > 0);
  const hiddenCount = selected.rows.length - activeRows.length;

  const rowsHtml = activeRows.map(row => {
    const proofsHtml = row.transfers.filter(item => item.proofUrl).map((item, index) => {
      const labelParts = ['Bukti ' + (index + 1)];
      if (item.nama_bank) labelParts.push(item.nama_bank);
      const timeLabel = formatAuditTime(item.timestamp);
      if (timeLabel) labelParts.push(timeLabel);
      const proofLabel = labelParts.join(' · ');
      const proofContext = [selected.cabang, formatAuditDateShort(row.date)].filter(Boolean).join(' · ');
      return '<a class="audit-proof-link" href="' + escHtml(item.proofUrl) + '" data-proof-url="' + escHtml(item.proofUrl) + '" data-proof-label="' + escHtml(proofLabel) + '" data-proof-context="' + escHtml(proofContext) + '" title="Buka bukti transfer di popup"><i class="bi bi-image"></i><span>' + escHtml(proofLabel) + '</span></a>';
    }).join('');

    const metaParts = [];
    if (row.proofCount > 0) metaParts.push(row.proofCount + ' bukti');
    if (row.transferMeta.length > 0) metaParts.push(row.transferMeta.join(' | '));

    return '<div class="audit-row ' + row.tone + '">' +
      '<div class="audit-line ' + row.tone + '">' + escHtml(row.line) + '</div>' +
      (metaParts.length ? '<div class="audit-row-meta">' + escHtml(metaParts.join(' · ')) + '</div>' : '') +
      (proofsHtml ? '<div class="audit-proof-list">' + proofsHtml + '</div>' : '') +
    '</div>';
  }).join('');

  const noActivityHtml = !activeRows.length
    ? '<div class="audit-empty-note"><i class="bi bi-inbox"></i>Belum ada NONCOD maupun transfer pada periode aktif.</div>'
    : '';
  const hiddenNote = hiddenCount > 0
    ? '<div class="audit-empty-note"><i class="bi bi-eye-slash"></i>' + hiddenCount + ' hari tanpa aktivitas disembunyikan.</div>'
    : '';

  detailEl.innerHTML = '<div class="audit-detail-card">' +
    '<div class="audit-detail-head">' +
      '<div>' +
        '<div class="audit-detail-title">' + escHtml(selected.cabang) + '</div>' +
        '<div class="audit-detail-sub">Audit harian ' + escHtml(getPeriodeLabel(dashboardAuditState.periode)) + ' · ' + summary.activeDays + ' hari aktif · ' + summary.proof + ' bukti tersimpan</div>' +
      '</div>' +
      '<div class="audit-cabang-area">' + escHtml(selected.area || 'LAINNYA') + '</div>' +
    '</div>' +
    '<div class="audit-stats">' +
      '<div class="audit-stat safe"><div class="audit-stat-val">' + summary.safe + '</div><div class="audit-stat-label">Aman</div></div>' +
      '<div class="audit-stat pending"><div class="audit-stat-val">' + summary.pending + '</div><div class="audit-stat-label">Kurang</div></div>' +
      '<div class="audit-stat warn"><div class="audit-stat-val">' + summary.warn + '</div><div class="audit-stat-label">Lebih / Cek</div></div>' +
      '<div class="audit-stat proof"><div class="audit-stat-val">' + summary.proof + '</div><div class="audit-stat-label">Bukti</div></div>' +
    '</div>' +
    '<div class="audit-rows">' + noActivityHtml + rowsHtml + hiddenNote + '</div>' +
  '</div>';
}

async function loadDashboardAudit(forceRefresh = false) {
  const periode = getCurrentPeriode();
  const listEl = document.getElementById('auditDashboardList');
  const detailEl = document.getElementById('auditDashboardDetail');
  const countEl = document.getElementById('auditDashboardCount');
  const badgeEl = document.getElementById('auditDashboardPeriodBadge');
  const refreshBtn = document.getElementById('auditDashboardRefreshBtn');

  if (badgeEl) {
    badgeEl.innerHTML = '<i class="bi bi-calendar-month"></i>' + escHtml(getPeriodeLabel(periode));
  }
  if (countEl) countEl.textContent = 'Memuat audit periode aktif...';
  if (listEl) listEl.innerHTML = '<div class="empty-note"><span class="spinner-border spinner-border-sm"></span></div>';
  if (detailEl) detailEl.innerHTML = '<div class="empty-note"><span class="spinner-border spinner-border-sm"></span></div>';
  if (refreshBtn) refreshBtn.classList.add('spinning');

  try {
    let payload = dashboardAuditCache;
    if (forceRefresh || !payload || payload.periode !== periode) {
      const [ncRes, dashRes, cabangRes] = await Promise.all([
        fetch('/api/noncod?periode=' + encodeURIComponent(periode) + '&mode=noncod'),
        fetch('/api/dashboard'),
        fetch('/api/cabang')
      ]);
      const [ncJson, dashJson, cabangJson] = await Promise.all([
        ncRes.json(),
        dashRes.json(),
        cabangRes.json()
      ]);

      if (!ncRes.ok) throw new Error(ncJson.error || 'Gagal memuat data NONCOD.');
      if (!dashRes.ok) throw new Error(dashJson.error || 'Gagal memuat data transfer dashboard.');
      if (!cabangRes.ok) throw new Error(cabangJson.error || 'Gagal memuat daftar cabang.');

      payload = {
        periode,
        ncData: ncJson,
        dashData: dashJson,
        cabangRows: Array.isArray(cabangJson.cabang) ? cabangJson.cabang : []
      };
      dashboardAuditCache = payload;
    }

    dashboardAuditState = buildDashboardAuditState(periode, payload.ncData, payload.dashData, payload.cabangRows);
    const items = getDashboardAuditItems();
    if (!items.length) {
      dashboardAuditSelectedCabang = '';
      if (countEl) countEl.textContent = 'Belum ada data audit untuk periode ' + getPeriodeLabel(periode) + '.';
      if (listEl) listEl.innerHTML = '<div class="empty-note">Belum ada data cabang yang bisa diaudit.</div>';
      if (detailEl) detailEl.innerHTML = '<div class="empty-note">Belum ada detail audit untuk periode aktif.</div>';
      return;
    }

    if (!items.some(item => item.cabang === dashboardAuditSelectedCabang)) {
      dashboardAuditSelectedCabang = items[0].cabang;
    }

    renderDashboardAuditList();
  } catch (err) {
    dashboardAuditState = null;
    if (countEl) countEl.textContent = 'Gagal memuat audit cabang.';
    if (listEl) listEl.innerHTML = '<div class="empty-note">' + escHtml(err.message || 'Gagal memuat data audit.') + '</div>';
    if (detailEl) detailEl.innerHTML = '<div class="empty-note">Audit cabang belum bisa ditampilkan.</div>';
  } finally {
    if (refreshBtn) refreshBtn.classList.remove('spinning');
  }
}

function renderTrendOverview(compareData) {
  const legendEl = document.getElementById('trendLegend');
  const chartEl = document.getElementById('trendChart');
  const periodsEl = document.getElementById('trendPeriods');
  const metricDefs = [
    { key: 'total', label: 'Total Omset', currentColor: '#60a5fa', previousColor: '#475569' },
    { key: 'noncod', label: 'NONCOD', currentColor: '#4ade80', previousColor: '#475569' },
    { key: 'dfod', label: 'DFOD', currentColor: '#fbbf24', previousColor: '#475569' },
  ];

  if (!compareData || !compareData.dayLabels || !compareData.dayLabels.length) {
    setDefaultTrendHeading();
    legendEl.innerHTML = '';
    chartEl.innerHTML = '<div class="empty-note">Belum ada data shipment untuk grafik periode terakhir.</div>';
    periodsEl.innerHTML = '';
    return;
  }

  const rangeLabel = getMtdRangeLabel(compareData.dayLabels[compareData.dayLabels.length - 1]);
  setTrendHeading('Perbandingan Harian ' + rangeLabel + ' · ' + compareData.previousLabel + ' vs ' + compareData.currentLabel);

  legendEl.innerHTML = metricDefs.map(item => {
    const value = Number(compareData.currentTotals[item.key] || 0);
    const delta = formatDelta(value, compareData.previousTotals[item.key] || 0);
    return '<div class="trend-legend-item">' +
      '<span class="trend-dot ' + (item.key === 'total' ? 'total' : item.key) + '"></span>' +
      '<div>' +
        '<div class="trend-series-label">' + item.label + '</div>' +
        '<div class="trend-series-value">' + fmtNominalCompact(value) + '</div>' +
        '<div class="trend-series-caption">' + escHtml(rangeLabel) + ' · ' + escHtml(compareData.currentLabel) + ' vs ' + escHtml(compareData.previousLabel) + '</div>' +
        '<div class="trend-series-delta ' + delta.cls + '">' + delta.text + '</div>' +
      '</div>' +
    '</div>';
  }).join('');

  const comparePills = '<div class="compare-pills">' +
    '<span class="compare-pill previous"><span class="cp-dot"></span>' + escHtml(compareData.previousLabel) + '</span>' +
    '<span class="compare-pill current"><span class="cp-dot"></span>' + escHtml(compareData.currentLabel) + '</span>' +
    '<span class="compare-pill range"><span class="cp-dot"></span>' + escHtml(rangeLabel) + '</span>' +
  '</div>';

  const panelHtml = metricDefs.map(item => {
    const previousPoints = compareData.daily[item.key].previous;
    const currentPoints = compareData.daily[item.key].current;
    const previousPeak = getPeakDailyPoint(previousPoints, compareData.dayLabels);
    const currentPeak = getPeakDailyPoint(currentPoints, compareData.dayLabels);
    const maxValue = Math.max(1, ...previousPoints, ...currentPoints);
    const dayCount = compareData.dayLabels.length;
    const width = Math.max(320, 44 * dayCount);
    const height = 260;
    const left = 46;
    const right = 16;
    const top = 18;
    const bottom = 34;
    const plotWidth = width - left - right;
    const plotHeight = height - top - bottom;
    const stepX = dayCount > 1 ? plotWidth / (dayCount - 1) : 0;
    const getX = index => dayCount > 1 ? left + (stepX * index) : left + (plotWidth / 2);
    const getY = value => top + plotHeight - ((Number(value || 0) / maxValue) * plotHeight);
    const yTickCount = 5;
    const yTicks = Array.from({length: yTickCount + 1}, (_, i) => Math.round(maxValue * (i / yTickCount)));
    const grid = yTicks.map(value => {
      const y = getY(value);
      return '<line class="trend-grid-line" x1="' + left + '" y1="' + y.toFixed(2) + '" x2="' + (width - right) + '" y2="' + y.toFixed(2) + '"></line>' +
        (value > 0 ? '<text class="trend-axis-label" x="' + (left - 6) + '" y="' + (y + 3).toFixed(2) + '" text-anchor="end">' + escHtml(fmtNominalCompact(value)) + '</text>' : '');
    }).join('');
    const xTicks = compareData.dayLabels.map((label, index) => '<text class="trend-axis-label" x="' + getX(index).toFixed(2) + '" y="' + (height - 10) + '" text-anchor="middle">' + escHtml(String(label)) + '</text>').join('');
    const prevCoords = previousPoints.map((value, index) => ({ x: getX(index), y: getY(value), value }));
    const currCoords = currentPoints.map((value, index) => ({ x: getX(index), y: getY(value), value }));
    const baseY = top + plotHeight;
    const prevAreaD = smoothAreaPath(prevCoords, baseY);
    const currAreaD = smoothAreaPath(currCoords, baseY);
    const prevPathD = smoothPath(prevCoords);
    const currPathD = smoothPath(currCoords);
    const prevMinorDots = prevCoords.slice(0, -1).map(p => '<circle class="trend-point minor" cx="' + p.x.toFixed(2) + '" cy="' + p.y.toFixed(2) + '" r="3" fill="' + item.previousColor + '"></circle>').join('');
    const currMinorDots = currCoords.slice(0, -1).map(p => '<circle class="trend-point minor" cx="' + p.x.toFixed(2) + '" cy="' + p.y.toFixed(2) + '" r="3.2" fill="' + item.currentColor + '"></circle>').join('');
    const prevEnd = prevCoords.length ? prevCoords[prevCoords.length - 1] : null;
    const currEnd = currCoords.length ? currCoords[currCoords.length - 1] : null;
    const prevEndDot = prevEnd ? '<circle class="trend-point end" cx="' + prevEnd.x.toFixed(2) + '" cy="' + prevEnd.y.toFixed(2) + '" r="5" fill="' + item.previousColor + '"></circle>' + '<text class="trend-end-label" x="' + (prevEnd.x + 1).toFixed(2) + '" y="' + (prevEnd.y - 9).toFixed(2) + '" text-anchor="middle">' + escHtml(fmtNominalCompact(prevEnd.value)) + '</text>' : '';
    const currEndDot = currEnd ? '<circle class="trend-point end" cx="' + currEnd.x.toFixed(2) + '" cy="' + currEnd.y.toFixed(2) + '" r="5.5" fill="' + item.currentColor + '"></circle>' + '<text class="trend-end-label" x="' + (currEnd.x + 1).toFixed(2) + '" y="' + (currEnd.y - 9).toFixed(2) + '" text-anchor="middle">' + escHtml(fmtNominalCompact(currEnd.value)) + '</text>' : '';
    const focusX = getX(dayCount - 1);
    const prevGradId = 'gPrev' + item.key;
    const currGradId = 'gCurr' + item.key;
    const delta = formatDelta(compareData.currentTotals[item.key], compareData.previousTotals[item.key]);
    return '<div class="daily-panel ' + item.key + '">' +
      '<div class="daily-panel-head">' +
        '<div>' +
          '<div class="daily-panel-title">' + item.label + '</div>' +
          '<div class="daily-panel-sub">' + escHtml(rangeLabel) + ' · ' + escHtml(compareData.previousShortLabel) + ' vs ' + escHtml(compareData.currentShortLabel) + '</div>' +
        '</div>' +
        '<div>' +
          '<div class="daily-panel-value">' + fmtNominalCompact(compareData.currentTotals[item.key]) + '</div>' +
          '<div class="daily-panel-delta ' + delta.cls + '">' + delta.text + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="daily-panel-series">' +
        '<span class="daily-series-chip" style="--series-color:' + item.previousColor + '"><span class="line"></span>' + escHtml(compareData.previousShortLabel) + '</span>' +
        '<span class="daily-series-chip" style="--series-color:' + item.currentColor + '"><span class="line"></span>' + escHtml(compareData.currentShortLabel) + '</span>' +
      '</div>' +
      '<svg class="daily-svg" viewBox="0 0 ' + width + ' ' + height + '" preserveAspectRatio="xMidYMid meet">' +
        '<defs>' +
          '<linearGradient id="' + prevGradId + '" x1="0" y1="0" x2="0" y2="1">' +
            '<stop offset="0%" stop-color="' + item.previousColor + '" stop-opacity="0.28"></stop>' +
            '<stop offset="60%" stop-color="' + item.previousColor + '" stop-opacity="0.06"></stop>' +
            '<stop offset="100%" stop-color="' + item.previousColor + '" stop-opacity="0"></stop>' +
          '</linearGradient>' +
          '<linearGradient id="' + currGradId + '" x1="0" y1="0" x2="0" y2="1">' +
            '<stop offset="0%" stop-color="' + item.currentColor + '" stop-opacity="0.38"></stop>' +
            '<stop offset="60%" stop-color="' + item.currentColor + '" stop-opacity="0.08"></stop>' +
            '<stop offset="100%" stop-color="' + item.currentColor + '" stop-opacity="0"></stop>' +
          '</linearGradient>' +
        '</defs>' +
        grid +
        '<line class="trend-focus-line" x1="' + focusX.toFixed(2) + '" y1="' + top + '" x2="' + focusX.toFixed(2) + '" y2="' + baseY + '"></line>' +
        '<path class="trend-area" d="' + prevAreaD + '" fill="url(#' + prevGradId + ')"></path>' +
        '<path class="trend-area" d="' + currAreaD + '" fill="url(#' + currGradId + ')"></path>' +
        '<path class="trend-line-glow" d="' + prevPathD + '" style="stroke:' + item.previousColor + ';stroke-width:10"></path>' +
        '<path class="trend-line-glow" d="' + currPathD + '" style="stroke:' + item.currentColor + ';stroke-width:12"></path>' +
        '<path class="trend-line" d="' + prevPathD + '" style="stroke:' + item.previousColor + ';stroke-width:2.8;opacity:0.7"></path>' +
        '<path class="trend-line" d="' + currPathD + '" style="stroke:' + item.currentColor + ';stroke-width:3.5"></path>' +
        prevMinorDots +
        currMinorDots +
        prevEndDot +
        currEndDot +
        xTicks +
      '</svg>' +
      '<div class="daily-panel-stats">' +
        '<div class="daily-stat">' +
          '<div class="daily-stat-label">Puncak ' + escHtml(compareData.previousShortLabel) + '</div>' +
          '<div class="daily-stat-value">Hari ' + previousPeak.day + ' · ' + fmtNominalCompact(previousPeak.value) + '</div>' +
        '</div>' +
        '<div class="daily-stat">' +
          '<div class="daily-stat-label">Puncak ' + escHtml(compareData.currentShortLabel) + '</div>' +
          '<div class="daily-stat-value">Hari ' + currentPeak.day + ' · ' + fmtNominalCompact(currentPeak.value) + '</div>' +
        '</div>' +
        '<div class="daily-stat">' +
          '<div class="daily-stat-label">Rata-rata / Hari</div>' +
          '<div class="daily-stat-value">' + fmtNominalCompact(Math.round(compareData.currentTotals[item.key] / Math.max(compareData.dayLabels.length, 1))) + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="daily-panel-meta">' +
        '<div>' + escHtml(compareData.previousLabel) + '<strong>' + fmtNominalCompact(compareData.previousTotals[item.key]) + '</strong></div>' +
        '<div style="text-align:right">' + escHtml(compareData.currentLabel) + '<strong>' + fmtNominalCompact(compareData.currentTotals[item.key]) + '</strong></div>' +
      '</div>' +
    '</div>';
  }).join('');

  chartEl.innerHTML = comparePills + '<div class="daily-compare-grid">' + panelHtml + '</div>';

  periodsEl.innerHTML = compareData.summaryCards.map((row, index) => '<div class="trend-period-item' + (index === compareData.summaryCards.length - 1 ? ' current' : '') + '">' +
    '<div class="tp-label">' + escHtml(row.label) + '</div>' +
    '<div class="tp-value">' + fmtNominalCompact(row.total) + '</div>' +
    '<div class="tp-meta">' + escHtml(rangeLabel) + '<br>NONCOD ' + fmtNominalCompact(row.noncod) + '<br>DFOD ' + fmtNominalCompact(row.dfod) + (row.fullTotal && row.fullTotal !== row.total ? '<br>Full bulan ' + fmtNominalCompact(row.fullTotal) : '') + '</div>' +
  '</div>').join('');
}

function renderBars(targetId, items, colorClass, formatter, emptyText) {
  const el = document.getElementById(targetId);
  if (!el) return;
  if (!items.length) {
    el.innerHTML = '<div class="empty-note">' + escHtml(emptyText) + '</div>';
    return;
  }
  const max = Math.max(...items.map(item => item.value), 1);
  el.innerHTML = items.map(item => {
    const width = Math.max(6, Math.round((item.value / max) * 100));
    return '<div class="bar-item">' +
      '<div class="bar-head">' +
        '<div class="bar-label" title="' + escHtml(item.label) + '">' + escHtml(item.label) + '</div>' +
        '<div class="bar-value">' + formatter(item.value) + '</div>' +
      '</div>' +
      (item.meta ? '<div class="bar-meta">' + escHtml(item.meta) + '</div>' : '') +
      '<div class="bar-track"><div class="bar-fill ' + colorClass + '" style="width:' + width + '%"></div></div>' +
    '</div>';
  }).join('');
}

function stopFrameLoadWatch(frameId, options = {}) {
  const frame = document.getElementById(frameId);
  if (frame && options.markBootSignaled) {
    frame.dataset.bootSignaled = '1';
  }
  const loadWatch = frameLoadWatches.get(frameId);
  if (!loadWatch) return;
  loadWatch.stop();
  frameLoadWatches.delete(frameId);
}

function handleWorkspaceChildMessage(event) {
  if (!event || event.origin !== location.origin) return;
  const payload = event.data;
  if (!payload || payload.type !== 'maulagi_admin_embed_status') return;
  const frame = document.getElementById('frameAdmin');
  const status = String(payload.status || '').trim().toLowerCase() || 'unknown';
  if (frame) {
    frame.dataset.bootStatus = status;
    if (status === 'ready') frame.dataset.bootReady = '1';
  }
  stopFrameLoadWatch('frameAdmin', { markBootSignaled: true });
  resolveFrameStatusWaiters('frameAdmin', status);
}

function stopDashboardBootWatch() {
  if (!dashboardBootWatch) return;
  dashboardBootWatch.stop();
  dashboardBootWatch = null;
}

function loadFrame(frameId) {
  const frame = document.getElementById(frameId);
  if (!frame) return;
  if (frameId === 'frameAdmin' && window.FrontendOpsReporter && frame.dataset.loaded !== '1' && frame.dataset.bootSignaled !== '1' && !frameLoadWatches.has(frameId)) {
    frameLoadWatches.set(frameId, window.FrontendOpsReporter.watch('Admin iframe loading lebih dari 20 detik', {
      action: 'admin_iframe_stalled',
      component: 'admin-iframe',
      timeoutMs: 20000,
    }));
  }
  if (!frame.src) frame.src = frame.dataset.src;
}

function getShipmentTargetTab() {
  return currentTab === 'dfod' ? 'dfod' : currentTab === 'noncod' ? 'noncod' : lastShipmentTab;
}

function getShipmentFrameId(tab) {
  return tab === 'dfod' ? 'frameDfod' : 'frameNoncod';
}

function runEmbeddedAction(tab, action) {
  const frame = document.getElementById(getShipmentFrameId(tab));
  if (!frame || !frame.contentWindow) return false;
  const fnName = action === 'upload' ? 'toggleUpload' : 'downloadXlsx';
  const fn = frame.contentWindow[fnName];
  if (typeof fn !== 'function') return false;
  fn.call(frame.contentWindow);
  return true;
}

function triggerShipmentAction(action) {
  if (action === 'upload' && !isAdminWorkspace()) return;
  const targetTab = getShipmentTargetTab();
  if (currentTab !== 'noncod' && currentTab !== 'dfod') {
    setTab(targetTab);
    if (runEmbeddedAction(targetTab, action)) {
      pendingShellAction = null;
      return;
    }
    pendingShellAction = { tab: targetTab, action };
    loadFrame(getShipmentFrameId(targetTab));
    return;
  }
  if (runEmbeddedAction(targetTab, action)) return;
  pendingShellAction = { tab: targetTab, action };
  loadFrame(getShipmentFrameId(targetTab));
}

function openWorkspaceUpload() {
  triggerShipmentAction('upload');
}

function downloadWorkspaceFile() {
  triggerShipmentAction('download');
}

function handleEmbeddedFrameLoad(frameId) {
  const frame = document.getElementById(frameId);
  if (frame) {
    frame.dataset.loaded = '1';
    frame.dataset.bootSignaled = '1';
  }
  stopFrameLoadWatch(frameId);
  if (!pendingShellAction) return;
  const targetFrameId = getShipmentFrameId(pendingShellAction.tab);
  if (frameId !== targetFrameId) return;
  if (runEmbeddedAction(pendingShellAction.tab, pendingShellAction.action)) {
    pendingShellAction = null;
  }
}

function resolveFrameStatusWaiters(frameId, status) {
  const waiters = frameStatusWaiters.get(frameId);
  if (!waiters || !waiters.length) return;

  const pendingWaiters = [];
  waiters.forEach((waiter) => {
    if (!waiter || !(waiter.expected instanceof Set)) return;
    if (waiter.expected.has(status)) {
      waiter.resolve(status);
      return;
    }
    pendingWaiters.push(waiter);
  });

  if (pendingWaiters.length) frameStatusWaiters.set(frameId, pendingWaiters);
  else frameStatusWaiters.delete(frameId);
}

function waitForFrameLoad(frameId, timeoutMs = 15000) {
  const frame = document.getElementById(frameId);
  if (!frame) return Promise.resolve(false);
  if (frame.dataset.loaded === '1') return Promise.resolve(true);

  return new Promise((resolve) => {
    const timerId = window.setTimeout(() => {
      frame.removeEventListener('load', onLoad);
      resolve(false);
    }, timeoutMs);

    function onLoad() {
      window.clearTimeout(timerId);
      resolve(true);
    }

    frame.addEventListener('load', onLoad, { once: true });
  });
}

function waitForFrameStatus(frameId, statuses, timeoutMs = 22000) {
  const frame = document.getElementById(frameId);
  if (!frame) return Promise.resolve('missing');

  const expected = new Set((Array.isArray(statuses) ? statuses : [statuses]).map((status) => String(status || '').trim().toLowerCase()).filter(Boolean));
  const currentStatus = String(frame.dataset.bootStatus || '').trim().toLowerCase();
  if (currentStatus && expected.has(currentStatus)) return Promise.resolve(currentStatus);

  return new Promise((resolve) => {
    let timerId = 0;
    const waiter = {
      expected,
      resolve(status) {
        window.clearTimeout(timerId);
        resolve(status);
      },
    };

    timerId = window.setTimeout(() => {
      const waiters = frameStatusWaiters.get(frameId) || [];
      const filteredWaiters = waiters.filter((item) => item !== waiter);
      if (filteredWaiters.length) frameStatusWaiters.set(frameId, filteredWaiters);
      else frameStatusWaiters.delete(frameId);
      resolve(String(frame.dataset.bootStatus || 'timeout').trim().toLowerCase() || 'timeout');
    }, timeoutMs);

    const waiters = frameStatusWaiters.get(frameId) || [];
    waiters.push(waiter);
    frameStatusWaiters.set(frameId, waiters);
  });
}

function setWorkspaceRefreshButtonState(isRefreshing) {
  const button = document.getElementById('workspaceRefreshBtn');
  if (!button) return;
  button.classList.toggle('spinning', !!isRefreshing);
  button.disabled = !!isRefreshing;
}

function hasLoadedFrame(frameId) {
  const frame = document.getElementById(frameId);
  return !!(frame && frame.src && frame.contentWindow);
}

async function refreshEmbeddedFrame(frameId, options = {}) {
  const frame = document.getElementById(frameId);
  if (!frame || !frame.src || !frame.contentWindow) return false;
  const refreshFn = frame.contentWindow.workspaceRefreshFromParent;
  if (typeof refreshFn !== 'function') return false;
  await refreshFn.call(frame.contentWindow, {
    force: true,
    source: 'workspace_parent',
    marker: options.marker || null,
  });
  return true;
}

function getLoadedWorkspaceFrameIds() {
  const frameIds = [];
  ['frameNoncod', 'frameDfod'].forEach(frameId => {
    if (hasLoadedFrame(frameId)) frameIds.push(frameId);
  });
  if (isAdminWorkspace() && hasLoadedFrame('frameAdmin')) {
    frameIds.push('frameAdmin');
  }
  return frameIds;
}

function shouldRefreshAuditWorkspace() {
  return currentTab === 'audit' || !!dashboardAuditCache || !!dashboardAuditState;
}

function normalizeWorkspaceMarkerScopes(marker) {
  const scopes = Array.isArray(marker && marker.scopes) ? marker.scopes : [];
  return [...new Set(scopes.map(scope => String(scope || '').trim().toLowerCase()).filter(Boolean))];
}

function workspaceMarkerHasScope(marker, scopeList) {
  const markerScopes = normalizeWorkspaceMarkerScopes(marker);
  const expected = new Set((Array.isArray(scopeList) ? scopeList : [scopeList]).map(scope => String(scope || '').trim().toLowerCase()).filter(Boolean));
  if (!markerScopes.length || !expected.size) return false;
  return markerScopes.some(scope => expected.has(scope));
}

function getWorkspaceMarkerRefreshPlan(marker) {
  return {
    includeOverview: workspaceMarkerHasScope(marker, ['overview']),
    includeAudit: workspaceMarkerHasScope(marker, ['audit']) && shouldRefreshAuditWorkspace(),
    includeFrames: workspaceMarkerHasScope(marker, ['noncod', 'dfod', 'transfer', 'manual_status', 'admin_monitor', 'admin_cabang', 'pending_allocation', 'carryover']),
  };
}

async function fetchWorkspaceMarker() {
  const res = await fetch('/api/dashboard?watch=1');
  if (!res.ok) throw new Error('Gagal memuat marker workspace.');
  const json = await res.json();
  return json && json.marker ? json.marker : null;
}

async function pollWorkspaceMarker(options = {}) {
  if (document.hidden || workspaceMarkerWatchBusy) return;

  workspaceMarkerWatchBusy = true;
  try {
    const marker = await fetchWorkspaceMarker();
    const nextToken = String(marker && marker.token || '').trim();
    if (!nextToken) return;

    const previousToken = workspaceMarkerToken;
    workspaceMarkerToken = nextToken;
  if (options.initialize) return;
    if (previousToken === nextToken) return;

    const refreshPlan = getWorkspaceMarkerRefreshPlan(marker);
    if (!refreshPlan.includeOverview && !refreshPlan.includeAudit && !refreshPlan.includeFrames) return;

    await requestWorkspaceRefresh({
      source: 'workspace_marker',
      spinOverview: false,
      includeOverview: refreshPlan.includeOverview,
      includeAudit: refreshPlan.includeAudit,
      includeFrames: refreshPlan.includeFrames,
      marker,
    });
  } finally {
    workspaceMarkerWatchBusy = false;
  }
}

function startWorkspaceMarkerWatch() {
  if (workspaceMarkerWatchId) return;
  workspaceMarkerWatchId = window.setInterval(() => {
    pollWorkspaceMarker().catch(() => {});
  }, WORKSPACE_MARKER_WATCH_MS);
}

async function requestWorkspaceRefresh(options = {}) {
  if (workspaceRefreshPromise) return workspaceRefreshPromise;

  const spinOverview = !!options.spinOverview;
  const includeOverview = options.includeOverview !== false;
  const includeAudit = options.includeAudit !== false;
  const includeFrames = options.includeFrames !== false;
  const marker = options.marker || null;

  setWorkspaceRefreshButtonState(true);
  workspaceRefreshPromise = (async () => {
    const tasks = [];
    if (includeOverview) tasks.push(loadOverview(spinOverview));
    if (includeAudit && shouldRefreshAuditWorkspace()) tasks.push(loadDashboardAudit(true));
    if (tasks.length) await Promise.allSettled(tasks);

    if (includeFrames) {
      const frameTasks = getLoadedWorkspaceFrameIds().map(frameId => refreshEmbeddedFrame(frameId, { marker }));
      if (frameTasks.length) await Promise.allSettled(frameTasks);
    }
  })().finally(() => {
    workspaceRefreshPromise = null;
    setWorkspaceRefreshButtonState(false);
  });

  return workspaceRefreshPromise;
}

window.requestWorkspaceRefresh = requestWorkspaceRefresh;

document.getElementById('frameNoncod').addEventListener('load', () => handleEmbeddedFrameLoad('frameNoncod'));
document.getElementById('frameDfod').addEventListener('load', () => handleEmbeddedFrameLoad('frameDfod'));
window.addEventListener('message', handleWorkspaceChildMessage);

function setTab(tab, updateHash = true, options = {}) {
  const suppressAutoLoad = !!options.suppressAutoLoad;
  const validTabs = isAdminWorkspace() ? ['dashboard', 'noncod', 'dfod', 'audit', 'admin'] : ['dashboard', 'noncod', 'dfod', 'audit'];
  currentTab = validTabs.includes(tab) ? tab : 'dashboard';
  if (currentTab === 'noncod' || currentTab === 'dfod') lastShipmentTab = currentTab;
  validTabs.forEach(name => {
    document.getElementById('tab-' + name).classList.toggle('active', name === currentTab);
    document.getElementById('panel-' + name).classList.toggle('active', name === currentTab);
  });
  if (updateHash) history.replaceState(null, '', '#' + currentTab);
  if (suppressAutoLoad) return currentTab;
  if (currentTab === 'noncod') loadFrame('frameNoncod');
  if (currentTab === 'dfod') loadFrame('frameDfod');
  if (currentTab === 'audit') loadDashboardAudit(false);
  if (currentTab === 'admin' && isAdminWorkspace()) loadFrame('frameAdmin');
  if (currentTab === 'dashboard') loadOverview(false);
  return currentTab;
}

function applyHashTab() {
  const hash = (location.hash || '#dashboard').replace('#', '');
  setTab(hash, false);
}

async function loadOverview(forceSpin) {
  const btn = document.getElementById('refreshOverviewBtn');
  if (forceSpin && btn) btn.classList.add('spinning');
  try {
    const periode = getCurrentPeriode();
    const [prevPeriode] = getRecentPeriodes(2, periode);
    const [dashRes, currentNoncod, currentDfod, prevNoncod, prevDfod] = await Promise.all([
      fetch('/api/dashboard'),
      fetchShipmentModeDataset(periode, 'noncod'),
      fetchShipmentModeDataset(periode, 'dfod'),
      fetchShipmentModeDataset(prevPeriode, 'noncod'),
      fetchShipmentModeDataset(prevPeriode, 'dfod')
    ]);

    const dashJson = await dashRes.json();
    if (!dashRes.ok) throw new Error(dashJson.error || 'Gagal memuat dashboard');

    const byCabang = dashJson.byCabang || {};
    const todayList = dashJson.todayList || [];
    const branchTotals = [];
    let monthTotal = 0;
    let monthTransactions = 0;

    Object.keys(byCabang).forEach(cabang => {
      const list = (byCabang[cabang].list || []).filter(item => item.periode === periode);
      if (!list.length) return;
      const total = list.reduce((sum, item) => sum + (item.nominal || 0), 0);
      monthTotal += total;
      monthTransactions += list.length;
      branchTotals.push({ label: cabang, value: total, meta: list.length + ' transaksi' });
    });

    branchTotals.sort((a, b) => b.value - a.value);

    const currentNoncodDays = extractDailyTotals(currentNoncod.byDay, periode);
    const currentDfodDays = extractDailyTotals(currentDfod.byDay, periode);
    let previousNoncodDays = extractDailyTotals(prevNoncod.byDay, prevPeriode);
    let previousDfodDays = extractDailyTotals(prevDfod.byDay, prevPeriode);
    if (!hasDailyRows(previousNoncodDays)) previousNoncodDays = extractDailyTotals(currentNoncod.byDay, prevPeriode);
    if (!hasDailyRows(previousDfodDays)) previousDfodDays = extractDailyTotals(currentDfod.byDay, prevPeriode);

    const currentMaxDay = Math.max(getMaxDailyDay(currentNoncodDays), getMaxDailyDay(currentDfodDays));
    const previousMaxDay = Math.max(getMaxDailyDay(previousNoncodDays), getMaxDailyDay(previousDfodDays));
    const dayLimit = currentMaxDay || previousMaxDay;
    const dayLabels = Array.from({ length: dayLimit }, (_, index) => index + 1);

    const currentSeries = {
      noncod: dayLabels.map(day => Number((currentNoncodDays[day] && currentNoncodDays[day].total) || 0)),
      dfod: dayLabels.map(day => Number((currentDfodDays[day] && currentDfodDays[day].total) || 0)),
    };
    currentSeries.total = currentSeries.noncod.map((value, index) => value + currentSeries.dfod[index]);

    const previousSeries = {
      noncod: dayLabels.map(day => Number((previousNoncodDays[day] && previousNoncodDays[day].total) || 0)),
      dfod: dayLabels.map(day => Number((previousDfodDays[day] && previousDfodDays[day].total) || 0)),
    };
    previousSeries.total = previousSeries.noncod.map((value, index) => value + previousSeries.dfod[index]);

    const totalNoncod = sumDailyMetric(currentNoncodDays, 'total');
    const totalDfod = sumDailyMetric(currentDfodDays, 'total');
    const totalOmset = totalNoncod + totalDfod;

    const compareData = dayLimit ? {
      previousLabel: getPeriodeLabel(prevPeriode),
      previousShortLabel: getPeriodeShortLabel(prevPeriode),
      currentLabel: getPeriodeLabel(periode),
      currentShortLabel: getPeriodeShortLabel(periode),
      dayLabels,
      currentTotals: {
        total: currentSeries.total.reduce((sum, value) => sum + value, 0),
        noncod: currentSeries.noncod.reduce((sum, value) => sum + value, 0),
        dfod: currentSeries.dfod.reduce((sum, value) => sum + value, 0),
      },
      previousTotals: {
        total: previousSeries.total.reduce((sum, value) => sum + value, 0),
        noncod: previousSeries.noncod.reduce((sum, value) => sum + value, 0),
        dfod: previousSeries.dfod.reduce((sum, value) => sum + value, 0),
      },
      daily: {
        total: { previous: previousSeries.total, current: currentSeries.total },
        noncod: { previous: previousSeries.noncod, current: currentSeries.noncod },
        dfod: { previous: previousSeries.dfod, current: currentSeries.dfod },
      },
      summaryCards: [
        {
          label: getPeriodeShortLabel(prevPeriode),
          total: previousSeries.total.reduce((sum, value) => sum + value, 0),
          noncod: previousSeries.noncod.reduce((sum, value) => sum + value, 0),
          dfod: previousSeries.dfod.reduce((sum, value) => sum + value, 0),
          fullTotal: Number((prevNoncod.monthSummary && prevNoncod.monthSummary.noncod && prevNoncod.monthSummary.noncod.grandTotal) || 0) + Number((prevDfod.monthSummary && prevDfod.monthSummary.dfod && prevDfod.monthSummary.dfod.grandTotal) || 0),
        },
        {
          label: getPeriodeShortLabel(periode),
          total: currentSeries.total.reduce((sum, value) => sum + value, 0),
          noncod: currentSeries.noncod.reduce((sum, value) => sum + value, 0),
          dfod: currentSeries.dfod.reduce((sum, value) => sum + value, 0),
          fullTotal: Number((currentNoncod.monthSummary && currentNoncod.monthSummary.noncod && currentNoncod.monthSummary.noncod.grandTotal) || 0) + Number((currentDfod.monthSummary && currentDfod.monthSummary.dfod && currentDfod.monthSummary.dfod.grandTotal) || 0),
        },
      ]
    } : null;

    const activeSyncInfo = currentNoncod.syncInfo || currentDfod.syncInfo || null;
    document.getElementById('workspaceStatus').textContent = getWorkspaceSnapshotStatus(periode, activeSyncInfo);
    updateWorkspaceSyncBanner(activeSyncInfo);
    setLatestTransferChip(dashJson.todayList && dashJson.todayList.length ? dashJson.todayList[dashJson.todayList.length - 1] : null);

    document.getElementById('ovBranches').textContent = Number(branchTotals.length).toLocaleString('id-ID');
    document.getElementById('ovBranchesMeta').textContent = 'Cabang dengan transfer pada ' + getPeriodeLabel(periode);

    document.getElementById('ovTransactions').textContent = Number(monthTransactions).toLocaleString('id-ID');
    document.getElementById('ovTransactionsMeta').textContent = 'Total transaksi pada periode aktif';

    document.getElementById('ovTotalMonth').textContent = fmtNominal(monthTotal);
    document.getElementById('ovTotalMonthMeta').textContent = getPeriodeLabel(periode) + ' · ' + fmtNominal(monthTotal);

    document.getElementById('ovCoverage').textContent = fmtNominal(totalOmset);
    document.getElementById('ovCoverageMeta').textContent = totalOmset > 0
      ? ('NONCOD ' + fmtNominal(totalNoncod) + ' · DFOD ' + fmtNominal(totalDfod))
      : 'Omset shipment belum tersedia';

    renderTrendOverview(compareData);
  } catch (err) {
    document.getElementById('workspaceStatus').textContent = 'Gagal memuat overview: ' + err.message;
    updateWorkspaceSyncBanner({ error: err.message });
    setLatestTransferChip(null);
    const statusChip = document.getElementById('statusChip');
    if (statusChip) {
      statusChip.textContent = 'Perlu cek';
      statusChip.style.display = '';
    }
    renderTrendOverview(null);
  } finally {
    if (btn) btn.classList.remove('spinning');
  }
}

function getRequestedWorkspaceTab() {
  const hash = (location.hash || '#dashboard').replace('#', '');
  const validTabs = isAdminWorkspace() ? ['dashboard', 'noncod', 'dfod', 'audit', 'admin'] : ['dashboard', 'noncod', 'dfod', 'audit'];
  return validTabs.includes(hash) ? hash : 'dashboard';
}

async function primeInitialWorkspace(tab) {
  const targetTab = setTab(tab, false, { suppressAutoLoad: true });

  if (targetTab === 'dashboard') {
    await loadOverview(false);
    return targetTab;
  }

  if (targetTab === 'audit') {
    await loadDashboardAudit(false);
    return targetTab;
  }

  if (targetTab === 'noncod' || targetTab === 'dfod') {
    const frameId = getShipmentFrameId(targetTab);
    loadFrame(frameId);
    await waitForFrameLoad(frameId);
    return targetTab;
  }

  if (targetTab === 'admin' && isAdminWorkspace()) {
    loadFrame('frameAdmin');
    await waitForFrameStatus('frameAdmin', ['ready', 'error'], 22000);
    return targetTab;
  }

  await loadOverview(false);
  return 'dashboard';
}

function runWarmupTask(task) {
  if (typeof task !== 'function') return Promise.resolve();
  if (typeof window.requestIdleCallback === 'function') {
    return new Promise((resolve) => {
      window.requestIdleCallback(() => {
        Promise.resolve(task()).catch(() => {}).finally(resolve);
      }, { timeout: 2000 });
    });
  }
  return Promise.resolve(task()).catch(() => {});
}

function queueBackgroundWorkspaceWarmup(initialTab) {
  if (workspaceWarmupPromise) return workspaceWarmupPromise;

  const tasks = [];
  if (initialTab !== 'dashboard') tasks.push(() => loadOverview(false));
  if (initialTab !== 'noncod') tasks.push(() => {
    loadFrame('frameNoncod');
    return waitForFrameLoad('frameNoncod', 12000);
  });
  if (initialTab !== 'dfod') tasks.push(() => {
    loadFrame('frameDfod');
    return waitForFrameLoad('frameDfod', 12000);
  });

  workspaceWarmupPromise = (async () => {
    for (const task of tasks) {
      await runWarmupTask(task);
    }
  })().finally(() => {
    workspaceWarmupPromise = null;
  });

  return workspaceWarmupPromise;
}

async function boot() {
  const wantsViewer = location.hash === '#viewer';
  const wantsAdmin = location.hash === '#admin';
  let activePrefix = wantsViewer && hasActiveSession('viewer') ? 'viewer' : wantsAdmin && hasActiveSession('admin') ? 'admin' : getActiveSessionPrefix();
  if (activePrefix && !isSessionExpired(activePrefix)) {
    const serverSession = await hasWorkspaceServerSession(activePrefix);
    if (serverSession === false) {
      clearWorkspaceSessions();
      activePrefix = '';
    }
  }

  // Hash viewer harus selalu memaksa context viewer, bukan mewarisi sesi dashboard/admin lama.
  if (wantsViewer) {
    if (hasActiveSession('viewer')) {
      clearConflictingViewerSessions();
      activePrefix = 'viewer';
    } else {
      clearConflictingViewerSessions();
      location.replace('/?viewer=1');
      return;
    }
  }

  if (wantsAdmin) {
    if (hasActiveSession('admin')) {
      clearConflictingAdminSessions();
      activePrefix = 'admin';
    } else {
      clearConflictingAdminSessions();
      activePrefix = '';
    }
  }

  if (!activePrefix || isSessionExpired(activePrefix)) {
    clearWorkspaceSessions();
    try {
      const targetRole = location.hash === '#admin' ? 'admin' : 'dashboard';
      const authKey = targetRole === 'admin' ? 'admin_password' : 'dashboard_password';
      const res = await fetch('/api/auth?key=' + authKey);
      const json = await res.json();
      if (json.hasPassword) {
        location.replace('/');
        return;
      }
      if (targetRole === 'admin') {
        sessionStorage.setItem('adminAuth', '1');
        sessionStorage.setItem('adminToken', '');
        setSessionTs('admin');
      } else {
        sessionStorage.setItem('dashAuth', '1');
        sessionStorage.setItem('dashToken', '');
        setSessionTs('dash');
      }
    } catch {
      location.replace('/');
      return;
    }
  }

  observeWorkspaceHeader();
  applyWorkspaceRoleUi();
  setDefaultTrendHeading();
  const initialTab = getRequestedWorkspaceTab();
  await primeInitialWorkspace(initialTab);
  hideLoading();
  stopDashboardBootWatch();
  queueBackgroundWorkspaceWarmup(initialTab);
  pollWorkspaceMarker({ initialize: true }).catch(() => {});
  startWorkspaceMarkerWatch();
}

initDashboardEventBindings();

window.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  if (isQuickModalOpen('auditProofModal')) {
    closeAuditProofModal();
    return;
  }
  if (isQuickModalOpen('latestTransferModal')) closeLatestTransferModal();
});
window.addEventListener('hashchange', applyHashTab);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    pollWorkspaceMarker().catch(() => {});
  }
});
window.addEventListener('pageshow', event => {
  if (!event.persisted) return;
  bootStarted = false;
  workspaceMarkerToken = '';
  if (workspaceMarkerWatchId) {
    clearInterval(workspaceMarkerWatchId);
    workspaceMarkerWatchId = 0;
  }
  startDashboardBoot();
});

function startDashboardBoot() {
  if (bootStarted) return;
  bootStarted = true;
  dashboardBootWatch = window.FrontendOpsReporter
    ? window.FrontendOpsReporter.watch('Dashboard loading lebih dari 20 detik', {
        action: 'dashboard_boot_stalled',
        component: 'dashboard-shell',
        timeoutMs: 20000,
      })
    : null;
  boot().catch(err => {
    console.error('Dashboard boot failed', err);
    if (window.FrontendOpsReporter) {
      window.FrontendOpsReporter.report(err, { action: 'dashboard_boot', component: 'dashboard-shell' });
    }
    clearWorkspaceSessions();
    location.replace('/');
  }).finally(() => {
    stopDashboardBootWatch();
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', startDashboardBoot, { once: true });
} else {
  startDashboardBoot();
}
