const PAGE_PARAMS = new URLSearchParams(location.search);
const EMBED_MODE = PAGE_PARAMS.get('embed') === '1' || window.self !== window.top;
const LOCKED_MODE = ['noncod', 'dfod'].includes(PAGE_PARAMS.get('mode')) ? PAGE_PARAMS.get('mode') : '';
if (EMBED_MODE) document.body.classList.add('embed');

const BULAN_ID = ['Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'];
const HARI_ID = ['Minggu','Senin','Selasa','Rabu','Kamis','Jumat','Sabtu'];

let ncByCabang = {};
let ncByDay = {};
let trByCabang = {};
let cabangAreaMap = {};
let allAreas = [];
const DEFAULT_NONCOD_STATUS = 'belum';
const NONCOD_MARKER_WATCH_MS = 10000;
let activeTab = 'today';
let activeArea = 'semua';
let activeStatus = DEFAULT_NONCOD_STATUS;
let activeMode = LOCKED_MODE || 'noncod';
let shipmentSummary = { noncod: {}, dfod: {}, all: {} };
let lastSyncInfo = null;
let _prevTransferCount = -1;
let _notifTimer = null;
let hasDashboardSnapshot = false;
let noncodMarkerWatchId = 0;
let noncodMarkerWatchBusy = false;
let noncodMarkerToken = '';
const noncodAggregation = window.NoncodAggregation;

window.workspaceRefreshFromParent = function(options = {}) {
  return loadDashboard({ forceRefresh: true, silent: true, marker: options.marker || null });
};

function initNoncodEventBindings() {
  const backBtn = document.getElementById('noncodBackBtn');
  const screenshotBtn = document.getElementById('btnScreenshot');
  const downloadBtn = document.getElementById('btnDownload');
  const dateWrap = document.getElementById('dateWrap');
  const calPopup = document.getElementById('calPopup');
  const calDays = document.getElementById('calDays');
  const calOverlay = document.getElementById('calOverlay');
  const periodeSelect = document.getElementById('periodeSelect');
  const modeSelect = document.getElementById('modeSelect');
  const areaSelect = document.getElementById('areaSelect');
  const statusSelect = document.getElementById('statusSelect');
  const searchCabang = document.getElementById('searchCabang');
  const trNotifCloseBtn = document.getElementById('trNotifCloseBtn');

  if (backBtn) backBtn.addEventListener('click', logoutWorkspace);
  if (screenshotBtn) screenshotBtn.addEventListener('click', captureScreenshot);
  if (downloadBtn) downloadBtn.addEventListener('click', downloadXlsx);
  document.querySelectorAll('.tab-btn[data-tab]').forEach(button => {
    button.addEventListener('click', () => setTab(button.dataset.tab || 'today'));
  });
  if (dateWrap) dateWrap.addEventListener('click', toggleCal);
  if (calPopup) calPopup.addEventListener('click', event => event.stopPropagation());
  document.querySelectorAll('[data-cal-nav]').forEach(button => {
    button.addEventListener('click', () => calNav(parseInt(button.dataset.calNav || '0', 10)));
  });
  if (document.getElementById('calTodayBtn')) document.getElementById('calTodayBtn').addEventListener('click', calSelectToday);
  if (document.getElementById('calApplyBtn')) document.getElementById('calApplyBtn').addEventListener('click', calApply);
  if (periodeSelect) periodeSelect.addEventListener('change', loadDashboard);
  if (modeSelect) modeSelect.addEventListener('change', event => setMode(event.target.value));
  if (areaSelect) areaSelect.addEventListener('change', event => setArea(event.target.value));
  if (statusSelect) statusSelect.addEventListener('change', event => setStatus(event.target.value));
  if (calOverlay) calOverlay.addEventListener('click', closeCal);
  if (searchCabang) searchCabang.addEventListener('input', renderCurrentTab);
  if (trNotifCloseBtn) trNotifCloseBtn.addEventListener('click', closeTransferNotif);
  if (calDays) {
    calDays.addEventListener('click', event => {
      const dayCell = event.target.closest('.cal-d[data-date]');
      if (!dayCell) return;
      calPick(dayCell.dataset.date || '');
    });
  }
}

if (!noncodAggregation) {
  throw new Error('Noncod aggregation module gagal dimuat.');
}

function showTransferNotif(cabang, nominal) {
  const title = document.getElementById('trNotifTitle');
  const sub = document.getElementById('trNotifSub');
  title.textContent = 'Transfer Baru Masuk!';
  sub.textContent = cabang
    ? cabang + (nominal ? ' · Rp ' + nominal.toLocaleString('id-ID') : '')
    : 'Data diperbarui otomatis';
  const el = document.getElementById('trNotif');
  el.classList.add('show');
  clearTimeout(_notifTimer);
  _notifTimer = setTimeout(() => el.classList.remove('show'), 6000);
}

function closeTransferNotif() {
  document.getElementById('trNotif').classList.remove('show');
  clearTimeout(_notifTimer);
}

function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
function fmtNom(n) { return n.toLocaleString('id-ID'); }
function fmtDate(d) { const dt = new Date(d + 'T00:00:00'); return HARI_ID[dt.getDay()] + ', ' + dt.getDate() + ' ' + BULAN_ID[dt.getMonth()]; }
function todayStr() { return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Makassar' }); }

function getSelectedPeriode() {
  const el = document.getElementById('periodeSelect');
  return String(el && el.value || '').trim();
}

function normalizeClientMarkerScopes(marker) {
  const scopes = Array.isArray(marker && marker.scopes) ? marker.scopes : [];
  return [...new Set(scopes.map(scope => String(scope || '').trim().toLowerCase()).filter(Boolean))];
}

function normalizeClientMarkerPeriodes(marker) {
  const periodes = Array.isArray(marker && marker.periodes) ? marker.periodes : [];
  return [...new Set(periodes.map(periode => String(periode || '').trim()).filter(Boolean))];
}

function clientMarkerHasScope(marker, scopeList) {
  const scopes = normalizeClientMarkerScopes(marker);
  const expected = new Set((Array.isArray(scopeList) ? scopeList : [scopeList]).map(scope => String(scope || '').trim().toLowerCase()).filter(Boolean));
  if (!scopes.length || !expected.size) return false;
  return scopes.some(scope => expected.has(scope));
}

function clientMarkerTouchesPeriode(marker, periode) {
  const periodes = normalizeClientMarkerPeriodes(marker);
  if (!periodes.length) return true;
  return periodes.includes(String(periode || '').trim());
}

function isNoncodMarkerRelevant(marker) {
  if (!marker) return true;
  const periode = getSelectedPeriode();
  if (!periode) return false;
  if (activeMode === 'dfod') {
    return clientMarkerHasScope(marker, ['dfod']) && clientMarkerTouchesPeriode(marker, periode);
  }
  return clientMarkerTouchesPeriode(marker, periode)
    && clientMarkerHasScope(marker, ['noncod', 'transfer', 'manual_status']);
}

async function fetchNoncodWriteMarker() {
  const res = await fetch('/api/dashboard?watch=1');
  if (!res.ok) throw new Error('Gagal memuat marker shipment.');
  const json = await res.json();
  return json && json.marker ? json.marker : null;
}

async function pollNoncodWriteMarker(options = {}) {
  if (EMBED_MODE || document.hidden || noncodMarkerWatchBusy) return;

  noncodMarkerWatchBusy = true;
  try {
    const marker = await fetchNoncodWriteMarker();
    const nextToken = String(marker && marker.token || '').trim();
    if (!nextToken) return;

    const previousToken = noncodMarkerToken;
    noncodMarkerToken = nextToken;
    if (options.initialize) return;
    if (previousToken === nextToken) return;
    if (!isNoncodMarkerRelevant(marker)) return;

    await loadDashboard({ forceRefresh: true, silent: true, marker });
  } finally {
    noncodMarkerWatchBusy = false;
  }
}

function startNoncodWriteMarkerWatch() {
  if (EMBED_MODE || noncodMarkerWatchId) return;
  noncodMarkerWatchId = window.setInterval(() => {
    pollNoncodWriteMarker().catch(() => {});
  }, NONCOD_MARKER_WATCH_MS);
}

function getWorksheetColumnWidth(header, rows) {
  const maxLength = rows.reduce((max, row) => {
    const value = row[header];
    const length = value == null ? 0 : String(value).length;
    return Math.max(max, length);
  }, String(header).length);
  return Math.min(36, Math.max(10, maxLength + 2));
}

function isNumericColumn(rows, header) {
  return rows.some(row => typeof row[header] === 'number')
    && rows.every(row => row[header] == null || row[header] === '' || typeof row[header] === 'number');
}

async function downloadRowsAsXlsx(rows, sheetName, fileName) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Dashboard Maulagi';
  workbook.created = new Date();

  const worksheet = workbook.addWorksheet(String(sheetName || 'Sheet1').slice(0, 31) || 'Sheet1');
  const headers = rows.length ? Object.keys(rows[0]) : [];

  worksheet.columns = headers.map(header => ({
    header,
    key: header,
    width: getWorksheetColumnWidth(header, rows),
  }));

  rows.forEach(row => worksheet.addRow(row));

  worksheet.views = [{ state: 'frozen', ySplit: 1 }];
  if (headers.length) {
    worksheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: Math.max(1, worksheet.rowCount), column: headers.length },
    };
  }

  const headerRow = worksheet.getRow(1);
  headerRow.eachCell(cell => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F172A' } };
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  });

  headers.forEach((header, index) => {
    if (isNumericColumn(rows, header)) {
      worksheet.getColumn(index + 1).numFmt = '#,##0';
    }
  });

  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob(
    [buffer],
    { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }
  );
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const SESSION_TIMEOUT = 60 * 60 * 1000; // 60 menit
const REMEMBERED_SESSION_TIMEOUT = 30 * 24 * 60 * 60 * 1000;
const SESSION_STATE_SUFFIXES = ['Auth', 'AuthTs', 'Token', 'AuthRemember', 'Cabang'];
const SESSION_CHECK_INTERVAL = 5000;

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
  const ts = parseInt(localStorage.getItem(prefix + 'AuthTs') || '0', 10);
  if (!auth || !ts || (Date.now() - ts > REMEMBERED_SESSION_TIMEOUT)) {
    clearStoredSession(prefix);
    return;
  }

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
function getActiveSessionPrefix() {
  if (hasActiveSession('admin')) return 'admin';
  if (hasActiveSession('dash')) return 'dash';
  if (hasActiveSession('viewer')) return 'viewer';
  return '';
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

async function doLogout() {
  clearWorkspaceSessions();
  await invalidateServerSession();
  try {
    if (window.top && window.top !== window.self) {
      window.top.location.replace('/');
      return;
    }
  } catch {}
  location.replace('/');
}

async function logoutWorkspace(event) {
  event.preventDefault();
  await doLogout();
}

// Auto-logout check every few seconds to match server token expiry
setInterval(() => {
  const prefix = getActiveSessionPrefix();
  if (prefix && isSessionExpired(prefix)) doLogout();
}, SESSION_CHECK_INTERVAL);

const activeSessionPrefix = getActiveSessionPrefix();
if (!activeSessionPrefix || isSessionExpired(activeSessionPrefix)) {
  clearWorkspaceSessions();
  // Verify server-side if dashboard password exists
  fetch('/api/auth?key=dashboard_password')
    .then(r => r.json())
    .then(json => {
      if (json.hasPassword) {
        location.replace('/');
      } else {
        sessionStorage.setItem('dashAuth', '1');
        sessionStorage.setItem('dashToken', '');
        setSessionTs('dash');
      }
    })
    .catch(() => location.replace('/'));
}

let dateFrom = todayStr();
let dateTo = todayStr();
let calViewYear, calViewMonth;
let calPickStep = 0; // 0 = picking start, 1 = picking end
let calTempFrom = '', calTempTo = '';

initNoncodEventBindings();

window.onload = () => {
  initPeriode();
  document.getElementById('modeSelect').value = activeMode;
  refreshModeUi();
  const t = todayStr();
  const dt = new Date(t + 'T00:00:00');
  calViewYear = dt.getFullYear();
  calViewMonth = dt.getMonth();
  updateDateLabel();
  loadDashboard();
  if (!EMBED_MODE) {
    pollNoncodWriteMarker({ initialize: true }).catch(() => {});
    startNoncodWriteMarkerWatch();
  }
};

document.addEventListener('visibilitychange', () => {
  if (!EMBED_MODE && !document.hidden) {
    pollNoncodWriteMarker().catch(() => {});
  }
});

function getDateFrom() { return dateFrom; }
function getDateTo() { return dateTo; }

function fmtDateShort(ds) {
  const dt = new Date(ds + 'T00:00:00');
  return dt.getDate() + ' ' + BULAN_ID[dt.getMonth()].slice(0, 3) + ' ' + dt.getFullYear();
}

function updateDateLabel() {
  const t = todayStr();
  let label;
  if (dateFrom === dateTo) {
    if (dateFrom === t) label = 'Hari ini, ' + fmtDateShort(dateFrom);
    else label = fmtDateShort(dateFrom);
  } else {
    const dtF = new Date(dateFrom + 'T00:00:00');
    const dtT = new Date(dateTo + 'T00:00:00');
    if (dtF.getMonth() === dtT.getMonth() && dtF.getFullYear() === dtT.getFullYear()) {
      label = dtF.getDate() + ' - ' + dtT.getDate() + ' ' + BULAN_ID[dtF.getMonth()].slice(0, 3) + ' ' + dtF.getFullYear();
    } else {
      label = fmtDateShort(dateFrom) + ' - ' + fmtDateShort(dateTo);
    }
  }
  document.getElementById('dateLabel').textContent = label;
}

function toggleCal() {
  const p = document.getElementById('calPopup');
  const o = document.getElementById('calOverlay');
  const w = document.getElementById('dateWrap');
  if (p.classList.contains('show')) { closeCal(); return; }
  calTempFrom = dateFrom;
  calTempTo = dateTo;
  calPickStep = 0;
  const dt = new Date(dateFrom + 'T00:00:00');
  calViewYear = dt.getFullYear();
  calViewMonth = dt.getMonth();
  renderCal();
  updateCalRangeInfo();
  p.classList.add('show');
  o.classList.add('show');
  w.classList.add('open');
  positionCalPopup();
}

function closeCal() {
  const popup = document.getElementById('calPopup');
  popup.classList.remove('show', 'place-top', 'place-bottom');
  popup.style.top = '';
  popup.style.left = '';
  document.getElementById('calOverlay').classList.remove('show');
  document.getElementById('dateWrap').classList.remove('open');
}

function positionCalPopup() {
  const popup = document.getElementById('calPopup');
  const trigger = document.getElementById('dateWrap');
  if (!popup || !trigger || !popup.classList.contains('show')) return;

  const margin = 12;
  const gap = 6;
  const triggerRect = trigger.getBoundingClientRect();
  const popupRect = popup.getBoundingClientRect();
  const popupWidth = popupRect.width || popup.offsetWidth || 290;
  const popupHeight = popupRect.height || popup.offsetHeight || 0;

  let left = triggerRect.left;
  if (left + popupWidth > window.innerWidth - margin) left = window.innerWidth - popupWidth - margin;
  if (left < margin) left = margin;

  let top = triggerRect.bottom + gap;
  let placement = 'bottom';
  if (top + popupHeight > window.innerHeight - margin) {
    const topCandidate = triggerRect.top - popupHeight - gap;
    if (topCandidate >= margin) {
      top = topCandidate;
      placement = 'top';
    } else {
      top = Math.max(margin, window.innerHeight - popupHeight - margin);
    }
  }

  popup.classList.remove('place-top', 'place-bottom');
  popup.classList.add(placement === 'top' ? 'place-top' : 'place-bottom');
  popup.style.left = Math.round(left) + 'px';
  popup.style.top = Math.round(top) + 'px';
}

function handleCalViewportChange() {
  if (document.getElementById('calPopup').classList.contains('show')) positionCalPopup();
}

function calNav(dir) {
  calViewMonth += dir;
  if (calViewMonth < 0) { calViewMonth = 11; calViewYear--; }
  if (calViewMonth > 11) { calViewMonth = 0; calViewYear++; }
  renderCal();
}

function updateCalRangeInfo() {
  document.getElementById('crStart').textContent = calTempFrom ? fmtDateShort(calTempFrom) : '...';
  document.getElementById('crEnd').textContent = calTempTo ? fmtDateShort(calTempTo) : '...';
}

function renderCal() {
  document.getElementById('calTitle').textContent = BULAN_ID[calViewMonth] + ' ' + calViewYear;
  const daysEl = document.getElementById('calDays');
  const headers = ['Min','Sen','Sel','Rab','Kam','Jum','Sab'];
  let html = headers.map(h => '<div class="cal-dh">' + h + '</div>').join('');

  const first = new Date(calViewYear, calViewMonth, 1);
  const startDay = first.getDay();
  const daysInMonth = new Date(calViewYear, calViewMonth + 1, 0).getDate();
  const prevDays = new Date(calViewYear, calViewMonth, 0).getDate();
  const todayS = todayStr();
  const pad = n => String(n).padStart(2, '0');

  for (let i = startDay - 1; i >= 0; i--) {
    html += '<div class="cal-d other">' + (prevDays - i) + '</div>';
  }
  for (let d = 1; d <= daysInMonth; d++) {
    const ds = calViewYear + '-' + pad(calViewMonth + 1) + '-' + pad(d);
    let cls = 'cal-d';
    if (ds === todayS) cls += ' today';
    if (calTempFrom && calTempTo) {
      if (ds === calTempFrom) cls += ' range-start';
      if (ds === calTempTo) cls += ' range-end';
      if (ds > calTempFrom && ds < calTempTo) cls += ' in-range';
    } else if (calTempFrom && ds === calTempFrom) {
      cls += ' range-start range-end';
    }
    html += '<div class="' + cls + '" data-date="' + ds + '">' + d + '</div>';
  }
  const total = startDay + daysInMonth;
  const remaining = (7 - (total % 7)) % 7;
  for (let d = 1; d <= remaining; d++) {
    html += '<div class="cal-d other">' + d + '</div>';
  }
  daysEl.innerHTML = html;
  handleCalViewportChange();
}

function calPick(ds) {
  if (calPickStep === 0) {
    calTempFrom = ds;
    calTempTo = '';
    calPickStep = 1;
  } else {
    if (ds < calTempFrom) {
      calTempTo = calTempFrom;
      calTempFrom = ds;
    } else {
      calTempTo = ds;
    }
    calPickStep = 0;
  }
  updateCalRangeInfo();
  renderCal();
}

function calApply() {
  if (!calTempFrom) return;
  dateFrom = calTempFrom;
  dateTo = calTempTo || calTempFrom;
  if (dateFrom > dateTo) { const tmp = dateFrom; dateFrom = dateTo; dateTo = tmp; }
  updateDateLabel();
  closeCal();
  renderCurrentTab();
}

function calSelectToday() {
  const t = todayStr();
  calTempFrom = t;
  calTempTo = t;
  calPickStep = 0;
  calApply();
}

function hideLoading() {
  document.getElementById('loadingScreen').classList.add('hide');
  setTimeout(() => { document.getElementById('loadingScreen').style.display = 'none'; document.getElementById('mainPage').classList.add('show'); }, 300);
}

window.addEventListener('resize', handleCalViewportChange);
window.addEventListener('scroll', handleCalViewportChange, true);

function initPeriode() {
  const sel = document.getElementById('periodeSelect');
  const now = new Date();
  for (let i = 0; i < 3; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const val = d.toLocaleDateString('en-CA', { year: 'numeric', month: '2-digit' }).slice(0, 7);
    sel.appendChild(new Option(BULAN_ID[d.getMonth()] + ' ' + d.getFullYear(), val));
  }
  sel.value = now.toLocaleDateString('en-CA', { year: 'numeric', month: '2-digit' }).slice(0, 7);
}

function setTab(t) {
  activeTab = t;
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('tab-' + t).classList.add('active');
  document.getElementById('dateWrap').style.display = (t === 'today') ? '' : 'none';
  document.getElementById('btnDownload').classList.add('show');
  closeCal();
  renderCurrentTab();
}

function setArea(a) {
  activeArea = a;
  document.getElementById('areaSelect').value = a;
  renderCurrentTab();
}

function getModeLabel(mode = activeMode) {
  if (mode === 'dfod') return 'DFOD';
  return 'NONCOD';
}

function formatSyncLabel(syncInfo) {
  if (!syncInfo) return ' · Status sync belum diketahui';
  if (syncInfo.error) return ' · Sync MauKirim gagal, pakai data terakhir';
  if (!syncInfo.enabled) return ' · Auto-sync MauKirim belum aktif';
  if (!syncInfo.eligible) return ' · Periode ini pakai data tersimpan';
  let stamp = '';
  if (syncInfo.syncedAt) {
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
      stamp = ' ' + dateLabel + ' · ' + timeLabel;
    } catch {}
  }
  if (syncInfo.refreshState && syncInfo.refreshState.status === 'running' && syncInfo.refreshState.action !== 'inline') {
    return ' · Snapshot sedang disegarkan otomatis' + (stamp ? ' · terakhir sync' + stamp : '');
  }
  if (syncInfo.refreshState && syncInfo.refreshState.status === 'queued') {
    return ' · Snapshot dijadwalkan refresh otomatis' + (stamp ? ' · terakhir sync' + stamp : '');
  }
  if (syncInfo.source === 'manual_upload') return ' · Data tersimpan sebelumnya' + (stamp ? ' · terakhir sync' + stamp : '');
  if (syncInfo.performed) return ' · Baru sinkron dari MauKirim' + (stamp ? ' · waktu sync' + stamp : '');
  return ' · Data MauKirim tersimpan' + (stamp ? ' · terakhir sync' + stamp : '');
}

function refreshModeUi() {
  const modeSelect = document.getElementById('modeSelect');
  const statusSelect = document.getElementById('statusSelect');
  const showStatus = activeMode === 'noncod';
  document.body.dataset.shipmentMode = activeMode;
  modeSelect.style.display = LOCKED_MODE ? 'none' : '';
  statusSelect.style.display = showStatus ? '' : 'none';
  if (showStatus) {
    statusSelect.value = activeStatus;
  } else {
    activeStatus = DEFAULT_NONCOD_STATUS;
    statusSelect.value = DEFAULT_NONCOD_STATUS;
  }
  document.getElementById('hdName').textContent = getModeLabel(activeMode);
}

function setMode(mode) {
  if (LOCKED_MODE) return;
  activeMode = ['noncod', 'dfod'].includes(mode) ? mode : 'noncod';
  document.getElementById('modeSelect').value = activeMode;
  refreshModeUi();
  loadDashboard();
}

function getSearchQ() { return (document.getElementById('searchCabang').value || '').trim().toLowerCase(); }
function filterByArea(c) { return activeArea === 'semua' || (cabangAreaMap[c] || '') === activeArea; }

function setStatus(s) {
  activeStatus = s;
  document.getElementById('statusSelect').value = s;
  renderCurrentTab();
}

function buildAreaPills() {
  const sel = document.getElementById('areaSelect');
  const areas = new Set();
  Object.values(cabangAreaMap).forEach(a => { if (a) areas.add(a); });
  allAreas = [...areas].sort();
  const prev = sel.value;
  sel.innerHTML = '<option value="semua">Semua Area</option>';
  allAreas.forEach(a => {
    sel.appendChild(new Option(a, a));
  });
  if (allAreas.includes(prev)) sel.value = prev;
  else { sel.value = 'semua'; activeArea = 'semua'; }
}

let _loadingDashboard = false;
function _showTableLoading() { document.getElementById('tableLoading').classList.add('show'); }
function _hideTableLoading() { document.getElementById('tableLoading').classList.remove('show'); }

async function loadDashboard(options = {}) {
  const periode = document.getElementById('periodeSelect').value;
  const marker = options.marker || null;
  const silent = !!options.silent;
  const shouldShowLoading = !silent && !hasDashboardSnapshot;
  if (!periode || _loadingDashboard) return;
  if (marker && !isNoncodMarkerRelevant(marker)) return;
  _loadingDashboard = true;
  if (shouldShowLoading) _showTableLoading();
  try {
    const [ncRes, trRes, cbRes] = await Promise.all([
      fetch('/api/noncod?periode=' + encodeURIComponent(periode) + '&mode=' + encodeURIComponent(activeMode)),
      activeMode === 'noncod'
        ? fetch('/api/dashboard')
        : Promise.resolve({ ok: true, json: async () => ({ byCabang: {}, todayList: [], lastUpdate: '-' }) }),
      fetch('/api/cabang'),
    ]);
    const ncJson = await ncRes.json();
    const trJson = await trRes.json();
    const cbJson = await cbRes.json();

    hideLoading();
    document.getElementById('mainContent').style.display = '';
    document.getElementById('errCard').style.display = 'none';
    const [pY, pM] = periode.split('-');
    lastSyncInfo = ncJson.syncInfo || null;
    document.getElementById('hdStatus').textContent = 'Periode: ' + BULAN_ID[parseInt(pM) - 1] + ' ' + pY + ' · Mode ' + getModeLabel(activeMode) + formatSyncLabel(lastSyncInfo);

    cabangAreaMap = {};
    (cbJson.cabang || []).forEach(c => { cabangAreaMap[c.nama] = c.area || ''; });
    buildAreaPills();

    ncByCabang = ncJson.byCabang || {};
    ncByDay = ncJson.byDay || {};
    shipmentSummary = ncJson.summary || { noncod: {}, dfod: {}, all: {} };
    const newTrByCabang = trJson.byCabang || {};

    // Detect new transfer entries
    const newCount = activeMode === 'noncod'
      ? Object.values(newTrByCabang).reduce((s, v) => s + (v.list ? v.list.length : 0), 0)
      : -1;
    if (activeMode === 'noncod' && _prevTransferCount >= 0 && newCount > _prevTransferCount) {
      // Find which cabang got a new transfer (most recent)
      let newestCabang = '', newestNominal = 0;
      let newestTime = '';
      for (const cab in newTrByCabang) {
        const list = newTrByCabang[cab].list || [];
        const prev = (trByCabang[cab] && trByCabang[cab].list) ? trByCabang[cab].list.length : 0;
        if (list.length > prev) {
          const last = list[list.length - 1];
          if (!newestTime || (last.createdAt || '') > newestTime) {
            newestTime = last.createdAt || '';
            newestCabang = cab;
            newestNominal = last.nominal || 0;
          }
        }
      }
      showTransferNotif(newestCabang, newestNominal);
    }
    _prevTransferCount = newCount;
    trByCabang = activeMode === 'noncod' ? newTrByCabang : {};
    if (activeMode !== 'noncod') closeTransferNotif();

    hasDashboardSnapshot = true;
    _hideTableLoading();
    renderCurrentTab();
  } catch (err) {
    _hideTableLoading();
    hideLoading();
    if (!hasDashboardSnapshot) {
      document.getElementById('errCard').style.display = '';
      document.getElementById('errMsg').textContent = 'Gagal memuat: ' + err.message;
    }
  } finally {
    _loadingDashboard = false;
  }
}

function renderCurrentTab() {
  document.getElementById('btnDownload').classList.add('show');
  if (activeMode === 'noncod') {
    if (activeTab === 'today') renderToday();
    else renderMonthly();
    return;
  }
  if (activeTab === 'today') renderShipmentToday();
  else renderShipmentMonthly();
}

// ========= TAB: HARI INI =========
function buildDateRange(from, to) {
  return noncodAggregation.buildDateRange(from, to);
}

function getDateRange() {
  return buildDateRange(getDateFrom(), getDateTo());
}

function getPeriodeDateRange(periode) {
  return noncodAggregation.getPeriodeDateRange(periode);
}

function getRekonDifference(ongkir, transfer) {
  if (noncodAggregation && typeof noncodAggregation.getRekonDifference === 'function') {
    return noncodAggregation.getRekonDifference(ongkir, transfer);
  }
  return Number(ongkir || 0) - Number(transfer || 0);
}

function getScopedDates(dates, periode) {
  return noncodAggregation.getScopedDates(dates, periode);
}

function getAggregatedRekonBaseRows(dates, periode) {
  return noncodAggregation.getAggregatedRekonBaseRows({ dates, periode, ncByDay, trByCabang });
}

function getFilteredRekonRows(baseRows, opts) {
  const hasExplicitQuery = opts && Object.prototype.hasOwnProperty.call(opts, 'q') && opts.q !== undefined;
  const hasExplicitStatus = opts && Object.prototype.hasOwnProperty.call(opts, 'status') && opts.status !== undefined;
  const q = hasExplicitQuery ? opts.q : getSearchQ();
  const statusFilter = hasExplicitStatus ? opts.status : activeStatus;
  return noncodAggregation.filterRekonRows(baseRows, {
    query: q,
    status: statusFilter,
    filterByArea,
  });
}

function getAggregatedShipmentRows(dates, periode) {
  return noncodAggregation.getAggregatedShipmentRows({ dates, periode, ncByDay });
}

function getTodayRows(opts) {
  const dates = (opts && opts.dates) || getDateRange();
  const periode = document.getElementById('periodeSelect').value;
  const filterOpts = {};
  if (opts && Object.prototype.hasOwnProperty.call(opts, 'q')) filterOpts.q = opts.q;
  if (opts && Object.prototype.hasOwnProperty.call(opts, 'status')) filterOpts.status = opts.status;
  const rows = getFilteredRekonRows(
    getAggregatedRekonBaseRows(dates, periode),
    filterOpts
  );
  rows.sort((a, b) => b.belum - a.belum);
  return rows;
}

function renderToday() {
  const rows = getTodayRows();
  // Statistik mengikuti search/area aktif, tetapi tanpa filter status.
  const allRows = getTodayRows({ status: 'semua' });
  const cntSudah = allRows.filter(r => r.belum <= 0).length;
  const cntBelum = allRows.filter(r => r.belum > 0).length;

  const totOngkir = allRows.reduce((s, r) => s + r.ongkir, 0);
  const totTransfer = allRows.reduce((s, r) => s + r.transfer, 0);
  const totBelum = allRows.reduce((s, r) => s + r.belum, 0);
  const totResi = allRows.reduce((s, r) => s + r.resi, 0);
  setStats('Total Ongkir', 'Rp ' + fmtNom(totOngkir), 'var(--dark)',
           'Sudah Transfer', 'Rp ' + fmtNom(totTransfer), 'var(--green)',
           'Belum Transfer', totBelum > 0 ? 'Rp ' + fmtNom(totBelum) : 'Rp 0', 'var(--red)',
           allRows.length + ' cabang · ' + totResi + ' resi',
           cntSudah + ' cabang',
           cntBelum + ' cabang');

  const thead = document.getElementById('tableHead');
  thead.innerHTML = '<tr><th>#</th><th>Cabang</th><th style="text-align:right">Resi</th><th style="text-align:right">Ongkir</th><th style="text-align:right">Transfer</th><th style="text-align:right">Belum</th></tr>';
  const tbody = document.getElementById('tableBody');
  if (rows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6"><div class="empty-msg"><i class="bi bi-inbox"></i>Tidak ada data untuk rentang tanggal ini</div></td></tr>';
    return;
  }
  const fTotResi = rows.reduce((s, r) => s + r.resi, 0);
  const fTotOngkir = rows.reduce((s, r) => s + r.ongkir, 0);
  const fTotTransfer = rows.reduce((s, r) => s + r.transfer, 0);
  const fTotBelum = rows.reduce((s, r) => s + r.belum, 0);
  tbody.innerHTML = rows.map((r, i) => '<tr>' +
    '<td style="color:#94a3b8;font-size:0.65rem">' + (i+1) + '</td>' +
    '<td class="td-cabang" title="' + esc(r.cabang) + '">' + esc(r.cabang) + '</td>' +
    '<td class="td-nom">' + (r.resi || '-') + '</td>' +
    '<td class="td-nom">' + (r.ongkir > 0 ? fmtNom(r.ongkir) : '-') + '</td>' +
    '<td class="td-nom" style="color:var(--green)">' + (r.transfer > 0 ? fmtNom(r.transfer) : '-') + '</td>' +
    '<td class="td-nom ' + (r.belum > 0 ? 'td-pos' : 'td-zero') + '">' + (r.belum > 0 ? fmtNom(r.belum) : r.belum === 0 ? '0' : '-' + fmtNom(Math.abs(r.belum))) + '</td>' +
    '</tr>').join('') +
    '<tr class="total-row">' +
    '<td colspan="2">TOTAL</td>' +
    '<td class="td-nom">' + fTotResi + '</td>' +
    '<td class="td-nom">' + fmtNom(fTotOngkir) + '</td>' +
    '<td class="td-nom" style="color:var(--green)">' + fmtNom(fTotTransfer) + '</td>' +
    '<td class="td-nom ' + (fTotBelum > 0 ? 'td-pos' : 'td-zero') + '">' + (fTotBelum > 0 ? fmtNom(fTotBelum) : '0') + '</td>' +
    '</tr>';
}

function getShipmentTodayRows() {
  const dates = getDateRange();
  const periode = document.getElementById('periodeSelect').value;
  const q = getSearchQ();
  const rows = getAggregatedShipmentRows(dates, periode).filter(row => {
    if (!filterByArea(row.cabang)) return false;
    if (q && !row.cabang.toLowerCase().includes(q)) return false;
    return true;
  });
  rows.sort((a, b) => b.total - a.total || b.ongkir - a.ongkir);
  return rows;
}

function renderShipmentToday() {
  const rows = getShipmentTodayRows();
  const totalResi = rows.reduce((sum, row) => sum + row.resi, 0);
  const totalOngkir = rows.reduce((sum, row) => sum + row.ongkir, 0);
  const totalOmset = rows.reduce((sum, row) => sum + row.total, 0);
  const modeLabel = activeMode === 'dfod' ? 'DFOD' : 'Shipment';

  setStats(
    'Omset ' + modeLabel,
    'Rp ' + fmtNom(totalOmset),
    'var(--blue)',
    'Total Ongkir',
    'Rp ' + fmtNom(totalOngkir),
    'var(--green)',
    'Total Resi',
    fmtNom(totalResi),
    'var(--dark)',
    rows.length + ' cabang',
    getModeLabel(activeMode),
    dateFrom === dateTo ? fmtDateShort(dateFrom) : fmtDateShort(dateFrom) + ' - ' + fmtDateShort(dateTo)
  );

  document.getElementById('tableHead').innerHTML = '<tr><th>#</th><th>Cabang</th><th style="text-align:right">Resi</th><th style="text-align:right">Ongkir</th><th style="text-align:right">Omset</th></tr>';
  const tbody = document.getElementById('tableBody');
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="5"><div class="empty-msg"><i class="bi bi-inbox"></i>Tidak ada data ' + getModeLabel(activeMode) + ' untuk rentang tanggal ini</div></td></tr>';
    return;
  }

  tbody.innerHTML = rows.map((row, idx) => '<tr>' +
    '<td style="color:#94a3b8;font-size:0.65rem">' + (idx + 1) + '</td>' +
    '<td class="td-cabang" title="' + esc(row.cabang) + '">' + esc(row.cabang) + '</td>' +
    '<td class="td-nom">' + fmtNom(row.resi) + '</td>' +
    '<td class="td-nom">' + (row.ongkir > 0 ? fmtNom(row.ongkir) : '-') + '</td>' +
    '<td class="td-nom" style="color:var(--dark)">' + (row.total > 0 ? fmtNom(row.total) : '-') + '</td>' +
    '</tr>').join('') +
    '<tr class="total-row">' +
    '<td colspan="2">TOTAL</td>' +
    '<td class="td-nom">' + fmtNom(totalResi) + '</td>' +
    '<td class="td-nom">' + fmtNom(totalOngkir) + '</td>' +
    '<td class="td-nom">' + fmtNom(totalOmset) + '</td>' +
    '</tr>';
}

function getMonthlyCabangMap() {
  const periode = document.getElementById('periodeSelect').value;
  const agg = {};

  getAggregatedShipmentRows(getPeriodeDateRange(periode), periode).forEach(row => {
    agg[row.cabang] = { ongkir: row.ongkir, resi: row.resi, total: row.total };
  });

  return agg;
}

// ========= TAB: BULANAN =========
let _monthlyRows = []; // store for download
function renderMonthly() {
  const q = getSearchQ();
  const periode = document.getElementById('periodeSelect').value;
  const baseRows = getAggregatedRekonBaseRows(getPeriodeDateRange(periode), periode);
  let rows = getFilteredRekonRows(baseRows, { q, status: activeStatus }).map(row => {
    const selisih = row.belum;
    return {
      cabang: row.cabang,
      resi: row.resi,
      area: cabangAreaMap[row.cabang] || '-',
      ongkir: row.ongkir,
      transfer: row.transfer,
      selisih,
      status: selisih <= 0 ? 'done' : 'belum',
    };
  });
  // Sort: area desc, cabang asc
  rows.sort((a, b) => b.area.localeCompare(a.area) || a.cabang.localeCompare(b.cabang));
  _monthlyRows = rows;

  // Build unfiltered stats for counts
  const allRows = getFilteredRekonRows(baseRows, { q, status: 'semua' });
  const cntDone = allRows.filter(r => r.belum <= 0).length;
  const cntBelum = allRows.filter(r => r.belum > 0).length;
  const allTotOngkir = allRows.reduce((s, r) => s + r.ongkir, 0);
  const allTotTransfer = allRows.reduce((s, r) => s + r.transfer, 0);
  const allTotResi = allRows.reduce((s, r) => s + r.resi, 0);
  const allSelisih = allRows.reduce((s, r) => s + r.belum, 0);
  const allSelisihLabel = allSelisih > 0 ? 'Rp ' + fmtNom(allSelisih) : allSelisih === 0 ? 'Rp 0' : '-Rp ' + fmtNom(Math.abs(allSelisih));
  const allSelisihColor = allSelisih > 0 ? 'var(--red)' : allSelisih < 0 ? 'var(--green)' : 'var(--dark)';

  setStats('Total Ongkir', 'Rp ' + fmtNom(allTotOngkir), 'var(--dark)',
           'Total Transfer', 'Rp ' + fmtNom(allTotTransfer), 'var(--green)',
     'Selisih', allSelisihLabel, allSelisihColor,
           allRows.length + ' cabang · ' + fmtNom(allTotResi) + ' resi',
           cntDone + ' done',
           cntBelum + ' belum');

  const thead = document.getElementById('tableHead');
  thead.innerHTML = '<tr><th>Cabang</th><th style="text-align:right">Resi</th><th>Area</th><th style="text-align:right">Ongkir</th><th style="text-align:right">Transfer</th><th style="text-align:right">Selisih</th><th style="text-align:center">Status</th></tr>';
  const tbody = document.getElementById('tableBody');
  if (rows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7"><div class="empty-msg"><i class="bi bi-inbox"></i>Tidak ada data</div></td></tr>';
    return;
  }

  let html = '';

  html += rows.map(r => {
    const badge = r.status === 'done' ? '<span class="badge-done">DONE</span>' : '<span class="badge-belum">BELUM</span>';
    const selisihClass = r.selisih > 0 ? 'td-pos' : r.selisih < 0 ? 'td-zero' : '';
    const selisihLabel = r.selisih > 0 ? fmtNom(r.selisih) : r.selisih < 0 ? '-' + fmtNom(Math.abs(r.selisih)) : '0';
    return '<tr>' +
      '<td class="td-cabang" title="' + esc(r.cabang) + '">' + esc(r.cabang) + '</td>' +
      '<td class="td-nom">' + (r.resi > 0 ? fmtNom(r.resi) : '-') + '</td>' +
      '<td style="font-size:0.65rem;color:#94a3b8">' + esc(r.area) + '</td>' +
      '<td class="td-nom">' + (r.ongkir > 0 ? fmtNom(r.ongkir) : '-') + '</td>' +
      '<td class="td-nom" style="color:var(--green)">' + (r.transfer > 0 ? fmtNom(r.transfer) : '-') + '</td>' +
      '<td class="td-nom ' + selisihClass + '">' + selisihLabel + '</td>' +
      '<td class="td-status">' + badge + '</td>' +
      '</tr>';
  }).join('');

  tbody.innerHTML = html;
}

function renderShipmentMonthly() {
  const q = getSearchQ();
  const monthRows = getMonthlyCabangMap();
  let rows = Object.keys(monthRows).map(cabang => ({
    cabang,
    resi: monthRows[cabang].resi || 0,
    area: cabangAreaMap[cabang] || '-',
    ongkir: monthRows[cabang].ongkir || 0,
    total: monthRows[cabang].total || 0,
  })).filter(row => {
    if (!row.cabang || row.cabang === '-') return false;
    if (!filterByArea(row.cabang)) return false;
    if (q && !row.cabang.toLowerCase().includes(q)) return false;
    return true;
  });

  rows.sort((a, b) => b.total - a.total || a.cabang.localeCompare(b.cabang));
  _monthlyRows = rows;

  const totalResi = rows.reduce((sum, row) => sum + row.resi, 0);
  const totalOngkir = rows.reduce((sum, row) => sum + row.ongkir, 0);
  const totalOmset = rows.reduce((sum, row) => sum + row.total, 0);
  const modeLabel = activeMode === 'dfod' ? 'DFOD' : 'Shipment';

  setStats(
    'Omset ' + modeLabel,
    'Rp ' + fmtNom(totalOmset),
    'var(--blue)',
    'Total Ongkir',
    'Rp ' + fmtNom(totalOngkir),
    'var(--green)',
    'Total Resi',
    fmtNom(totalResi),
    'var(--dark)',
    rows.length + ' cabang',
    getModeLabel(activeMode),
    document.getElementById('periodeSelect').selectedOptions[0] ? document.getElementById('periodeSelect').selectedOptions[0].textContent : ''
  );

  document.getElementById('tableHead').innerHTML = '<tr><th>Cabang</th><th style="text-align:right">Resi</th><th>Area</th><th style="text-align:right">Ongkir</th><th style="text-align:right">Omset</th></tr>';
  const tbody = document.getElementById('tableBody');
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="5"><div class="empty-msg"><i class="bi bi-inbox"></i>Tidak ada data ' + getModeLabel(activeMode) + ' pada periode ini</div></td></tr>';
    return;
  }

  tbody.innerHTML = rows.map(row => '<tr>' +
    '<td class="td-cabang" title="' + esc(row.cabang) + '">' + esc(row.cabang) + '</td>' +
    '<td class="td-nom">' + fmtNom(row.resi) + '</td>' +
    '<td style="font-size:0.65rem;color:#94a3b8">' + esc(row.area) + '</td>' +
    '<td class="td-nom">' + (row.ongkir > 0 ? fmtNom(row.ongkir) : '-') + '</td>' +
    '<td class="td-nom" style="color:var(--dark)">' + (row.total > 0 ? fmtNom(row.total) : '-') + '</td>' +
    '</tr>').join('') +
    '<tr class="total-row">' +
    '<td>TOTAL</td>' +
    '<td class="td-nom">' + fmtNom(totalResi) + '</td>' +
    '<td></td>' +
    '<td class="td-nom">' + fmtNom(totalOngkir) + '</td>' +
    '<td class="td-nom">' + fmtNom(totalOmset) + '</td>' +
    '</tr>';
}

// ========= DOWNLOAD XLSX =========
async function downloadXlsx() {
  if (activeTab === 'today') return downloadTodayXlsx();
  return downloadMonthlyXlsx();
}

async function downloadTodayXlsx() {
  if (activeMode !== 'noncod') {
    const rows = getShipmentTodayRows();
    if (!rows.length) { showToast('Tidak ada data untuk diunduh', 'error'); return; }

    const data = rows.map((row, idx) => ({
      'No': idx + 1,
      'Cabang': row.cabang,
      'Resi': row.resi,
      'Ongkir': row.ongkir,
      'Omset': row.total,
    }));

    const totalResi = rows.reduce((sum, row) => sum + row.resi, 0);
    const totalOngkir = rows.reduce((sum, row) => sum + row.ongkir, 0);
    const totalOmset = rows.reduce((sum, row) => sum + row.total, 0);
    data.push({ 'No': '', 'Cabang': 'TOTAL', 'Resi': totalResi, 'Ongkir': totalOngkir, 'Omset': totalOmset });

    const modeName = getModeLabel(activeMode).replace(/\s+/g, '_');
    const dF = new Date(dateFrom + 'T00:00:00');
    const dT = new Date(dateTo + 'T00:00:00');
    const bF = BULAN_ID[dF.getMonth()].toLowerCase();
    const bT = BULAN_ID[dT.getMonth()].toLowerCase();
    let fname = 'Rekap_' + modeName.toLowerCase() + '_daily_' + dF.getDate() + '_' + bF + '_' + dF.getFullYear();
    if (dateFrom !== dateTo) fname += '_-_' + dT.getDate() + '_' + bT + '_' + dT.getFullYear();
    fname += '.xlsx';
    await downloadRowsAsXlsx(data, 'Hari Ini', fname);
    showToast('File ' + fname + ' berhasil diunduh', 'success');
    return;
  }

  const rows = getTodayRows();
  if (!rows.length) { showToast('Tidak ada data untuk diunduh', 'error'); return; }
  const periode = document.getElementById('periodeSelect').value;
  const [pY, pM] = periode.split('-');

  const data = rows.map((r, i) => ({
    'No': i + 1,
    'Cabang': r.cabang,
    'Resi': r.resi,
    'Ongkir': r.ongkir,
    'Transfer': r.transfer,
    'Belum': r.belum,
    'Status': r.belum <= 0 ? 'DONE' : 'BELUM'
  }));

  const totResi = rows.reduce((s, r) => s + r.resi, 0);
  const totOngkir = rows.reduce((s, r) => s + r.ongkir, 0);
  const totTransfer = rows.reduce((s, r) => s + r.transfer, 0);
  const totBelum = rows.reduce((s, r) => s + r.belum, 0);
  data.push({ 'No': '', 'Cabang': 'TOTAL', 'Resi': totResi, 'Ongkir': totOngkir, 'Transfer': totTransfer, 'Belum': totBelum, 'Status': '' });

  const f = dateFrom, t = dateTo;
  const dF = new Date(f + 'T00:00:00'), dT = new Date(t + 'T00:00:00');
  const bF = BULAN_ID[dF.getMonth()].toLowerCase(), bT = BULAN_ID[dT.getMonth()].toLowerCase();
  let fname;
  if (f === t) { fname = 'Rekap_daily_' + dF.getDate() + '_' + bF + '_' + dF.getFullYear(); }
  else { fname = 'Rekap_daily_' + dF.getDate() + '_' + bF + '_' + dF.getFullYear() + '_-_' + dT.getDate() + '_' + bT + '_' + dT.getFullYear(); }
  const areaLabel = activeArea === 'semua' ? '' : activeArea;
  const statusLabel = activeStatus === 'semua' ? '' : (activeStatus === 'sudah' ? 'Done' : 'Belum');
  if (areaLabel) fname += '_' + areaLabel.replace(/\s+/g, '_');
  if (statusLabel) fname += '_' + statusLabel;
  fname += '.xlsx';
  await downloadRowsAsXlsx(data, 'Hari Ini', fname);
  showToast('File ' + fname + ' berhasil diunduh', 'success');
}

async function downloadMonthlyXlsx() {
  if (activeMode !== 'noncod') {
    if (!_monthlyRows.length) { showToast('Tidak ada data untuk diunduh', 'error'); return; }
    const periode = document.getElementById('periodeSelect').value;
    const [pY, pM] = periode.split('-');
    const bulanNama = BULAN_ID[parseInt(pM) - 1].toLowerCase();
    const modeName = getModeLabel(activeMode).replace(/\s+/g, '_').toLowerCase();

    const data = _monthlyRows.map(row => ({
      'Cabang': row.cabang,
      'Resi': row.resi,
      'Area': row.area,
      'Ongkir': row.ongkir,
      'Omset': row.total,
    }));

    const totalResi = _monthlyRows.reduce((sum, row) => sum + row.resi, 0);
    const totalOngkir = _monthlyRows.reduce((sum, row) => sum + row.ongkir, 0);
    const totalOmset = _monthlyRows.reduce((sum, row) => sum + row.total, 0);
    data.push({ 'Cabang': 'TOTAL', 'Resi': totalResi, 'Area': '', 'Ongkir': totalOngkir, 'Omset': totalOmset });

    const fname = 'Rekap_' + modeName + '_' + bulanNama + '_' + pY + '.xlsx';
    await downloadRowsAsXlsx(data, 'Rekap Bulanan', fname);
    showToast('File ' + fname + ' berhasil diunduh', 'success');
    return;
  }

  if (!_monthlyRows.length) { showToast('Tidak ada data untuk diunduh', 'error'); return; }
  const periode = document.getElementById('periodeSelect').value;
  const areaLabel = activeArea === 'semua' ? 'Semua Area' : activeArea;
  const statusLabel = activeStatus === 'semua' ? 'Semua' : activeStatus === 'sudah' ? 'Done' : 'Belum';

  const data = _monthlyRows.map(r => ({
    'Cabang': r.cabang,
    'Resi': r.resi,
    'Area': r.area,
    'Ongkir': r.ongkir,
    'Transfer': r.transfer,
    'Selisih': r.selisih,
    'Status': r.status === 'done' ? 'DONE' : 'BELUM'
  }));

  // Add total row
  const totResi = _monthlyRows.reduce((s, r) => s + r.resi, 0);
  const totOngkir = _monthlyRows.reduce((s, r) => s + r.ongkir, 0);
  const totTransfer = _monthlyRows.reduce((s, r) => s + r.transfer, 0);
  const totSelisih = _monthlyRows.reduce((s, r) => s + getRekonDifference(r.ongkir, r.transfer), 0);
  data.push({ 'Cabang': 'TOTAL', 'Resi': totResi, 'Area': '', 'Ongkir': totOngkir, 'Transfer': totTransfer, 'Selisih': totSelisih, 'Status': '' });

  const [pY, pM] = periode.split('-');
  const bulanNama = BULAN_ID[parseInt(pM) - 1].toLowerCase();
  let fname = 'Rekap_' + bulanNama + '_' + pY;
  if (areaLabel !== 'Semua Area') fname += '_' + areaLabel.replace(/\s+/g, '_');
  if (statusLabel !== 'Semua') fname += '_' + statusLabel;
  fname += '.xlsx';
  await downloadRowsAsXlsx(data, 'Rekap Bulanan', fname);
  showToast('File ' + fname + ' berhasil diunduh', 'success');
}

// ========= STATS HELPER =========
function setStats(l1, v1, c1, l2, v2, c2, l3, v3, c3, cnt1, cnt2, cnt3) {
  document.getElementById('stLbl1').textContent = l1;
  document.getElementById('stVal1').textContent = v1;
  document.getElementById('stVal1').style.color = c1;
  document.getElementById('stLbl2').textContent = l2;
  document.getElementById('stVal2').textContent = v2;
  document.getElementById('stVal2').style.color = c2;
  document.getElementById('stLbl3').textContent = l3;
  document.getElementById('stVal3').textContent = v3;
  document.getElementById('stVal3').style.color = c3;
  document.getElementById('stCnt1').textContent = cnt1 || '';
  document.getElementById('stCnt2').textContent = cnt2 || '';
  document.getElementById('stCnt3').textContent = cnt3 || '';
}

async function captureScreenshot() {
  const btn = document.getElementById('btnScreenshot');
  btn.style.opacity = '0.5';
  btn.style.pointerEvents = 'none';
  const target = document.getElementById('tableSection');
  const tableWrap = document.getElementById('tableWrap');
  const original = {
    maxHeight: tableWrap.style.maxHeight,
    overflowX: tableWrap.style.overflowX,
    overflowY: tableWrap.style.overflowY,
    height: tableWrap.style.height,
    scrollTop: tableWrap.scrollTop,
    scrollLeft: tableWrap.scrollLeft,
  };
  try {
    tableWrap.style.maxHeight = 'none';
    tableWrap.style.height = 'auto';
    tableWrap.style.overflowX = 'visible';
    tableWrap.style.overflowY = 'visible';
    tableWrap.scrollTop = 0;
    tableWrap.scrollLeft = 0;

    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

    const canvas = await html2canvas(target, {
      backgroundColor: getComputedStyle(document.body).getPropertyValue('background-color') || '#f8fafc',
      scale: 2,
      useCORS: true,
      logging: false,
      windowWidth: Math.max(target.scrollWidth, tableWrap.scrollWidth, document.documentElement.clientWidth),
      windowHeight: Math.max(target.scrollHeight, tableWrap.scrollHeight, target.offsetHeight),
    });
    canvas.toBlob(async blob => {
      try {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        showToast('Screenshot disalin ke clipboard! Tinggal Paste di WhatsApp.', 'success');
      } catch {
        // Fallback: download jika clipboard tidak diizinkan
        const a = document.createElement('a');
        a.href = canvas.toDataURL('image/png');
        a.download = 'dashboard_' + new Date().toLocaleDateString('en-CA') + '.png';
        a.click();
        showToast('Disimpan sebagai file (clipboard tidak diizinkan browser ini).', '');
      }
    }, 'image/png');
  } catch (err) {
    showToast('Gagal screenshot.', 'error');
  } finally {
    tableWrap.style.maxHeight = original.maxHeight;
    tableWrap.style.height = original.height;
    tableWrap.style.overflowX = original.overflowX;
    tableWrap.style.overflowY = original.overflowY;
    tableWrap.scrollTop = original.scrollTop;
    tableWrap.scrollLeft = original.scrollLeft;
    btn.style.opacity = '';
    btn.style.pointerEvents = '';
  }
}

function showToast(msg, type) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast-box show ' + (type || '');
  setTimeout(() => t.className = 'toast-box', 2200);
}
