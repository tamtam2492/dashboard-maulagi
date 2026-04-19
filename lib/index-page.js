(function () {
  const SESSION_TIMEOUT_MS = 60 * 60 * 1000;
  const REMEMBER_SESSION_TIMEOUT_MS = 30 * 24 * 60 * 60 * 1000;
  const SESSION_STATE_SUFFIXES = ['Auth', 'AuthTs', 'Token', 'AuthRemember', 'Cabang'];
  let allCabang = null;
  let loginMode = 'dashboard';
  let dashboardTargetTab = 'dashboard';

  document.addEventListener('DOMContentLoaded', init);

  function startOpsWatch(message, meta) {
    if (!window.FrontendOpsReporter) return null;
    return window.FrontendOpsReporter.watch(message, meta || {});
  }

  function reportOpsError(error, meta) {
    if (!window.FrontendOpsReporter) return;
    window.FrontendOpsReporter.report(error, meta || {});
  }

  function init() {
    const popCabang = document.getElementById('popCabang');
    const popCabangClose = document.getElementById('popCabangClose');
    const loginGate = document.getElementById('loginGate');
    const inpCabang = document.getElementById('inpCabang');
    const loginPw = document.getElementById('loginPw');
    const btnLogin = document.getElementById('btnLogin');

    if (!popCabang || !loginGate || !inpCabang || !loginPw || !btnLogin) return;

    popCabang.addEventListener('click', (event) => {
      if (event.target === popCabang) closePop();
    });

    if (popCabangClose) {
      popCabangClose.addEventListener('click', closePop);
    }

    loginGate.addEventListener('click', handleOverlayClick);
    inpCabang.addEventListener('input', (event) => renderCabangList(event.target.value));
    loginPw.addEventListener('input', clearLoginError);
    loginPw.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') doLogin();
    });
    btnLogin.addEventListener('click', doLogin);

    document.querySelectorAll('[data-dashboard-role]').forEach((element) => {
      element.addEventListener('click', (event) => {
        event.preventDefault();
        openDashboard(element.dataset.dashboardTarget || 'dashboard', element.dataset.dashboardRole || 'dashboard');
      });
    });

    const dashboardViewerCard = document.getElementById('dashboardViewerCard');
    if (dashboardViewerCard) {
      dashboardViewerCard.addEventListener('click', (event) => {
        event.preventDefault();
        openViewerEntry();
      });
    }

    const rekapCard = document.getElementById('rekapCard');
    if (rekapCard) {
      rekapCard.addEventListener('click', (event) => {
        event.preventDefault();
        openRekapPicker();
      });
    }

    const viewerLoginGate = document.getElementById('viewerLoginGate');
    if (viewerLoginGate) {
      viewerLoginGate.addEventListener('click', (event) => {
        if (event.target === viewerLoginGate) closeViewerLoginGate();
      });
    }

    const viewerPwEl = document.getElementById('viewerPw');
    if (viewerPwEl) {
      viewerPwEl.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') doViewerLogin();
      });
      viewerPwEl.addEventListener('input', () => {
        const err = document.getElementById('viewerErr');
        if (err) err.textContent = '';
      });
    }

    const viewerWaEl = document.getElementById('viewerWa');
    if (viewerWaEl) {
      viewerWaEl.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') doViewerLogin();
      });
    }

    const btnViewerLogin = document.getElementById('btnViewerLogin');
    if (btnViewerLogin) {
      btnViewerLogin.addEventListener('click', doViewerLogin);
    }

    loadVisitorCount();
    maybeOpenViewerFromQuery();
  }

  function maybeOpenViewerFromQuery() {
    const params = new URLSearchParams(location.search);
    if (params.get('viewer') !== '1') return;

    openViewerEntry();

    try {
      const nextUrl = location.pathname + (location.hash || '');
      window.history.replaceState({}, document.title, nextUrl);
    } catch {}
  }

  function getSessionKey(prefix, suffix) {
    return prefix + suffix;
  }

  function getStoredSessionValue(prefix, suffix) {
    const key = getSessionKey(prefix, suffix);
    const sessionValue = sessionStorage.getItem(key);
    if (sessionValue !== null) return sessionValue;
    const localValue = localStorage.getItem(key);
    return localValue !== null ? localValue : '';
  }

  function clearSession(prefix) {
    SESSION_STATE_SUFFIXES.forEach((suffix) => {
      const key = getSessionKey(prefix, suffix);
      sessionStorage.removeItem(key);
      localStorage.removeItem(key);
    });
  }

  function hydrateRememberedSession(prefix) {
    if (sessionStorage.getItem(getSessionKey(prefix, 'Auth')) !== null) return;
    if (localStorage.getItem(getSessionKey(prefix, 'AuthRemember')) !== '1') return;

    const auth = localStorage.getItem(getSessionKey(prefix, 'Auth'));
    const ts = parseInt(localStorage.getItem(getSessionKey(prefix, 'AuthTs')) || '0', 10);
    if (!auth || !ts || (Date.now() - ts > REMEMBER_SESSION_TIMEOUT_MS)) {
      clearSession(prefix);
      return;
    }

    SESSION_STATE_SUFFIXES.forEach((suffix) => {
      const value = localStorage.getItem(getSessionKey(prefix, suffix));
      if (value !== null) sessionStorage.setItem(getSessionKey(prefix, suffix), value);
    });
  }

  function getSessionTimeoutMs(prefix) {
    return getStoredSessionValue(prefix, 'AuthRemember') === '1'
      ? REMEMBER_SESSION_TIMEOUT_MS
      : SESSION_TIMEOUT_MS;
  }

  function hasValidSession(prefix) {
    hydrateRememberedSession(prefix);
    const auth = getStoredSessionValue(prefix, 'Auth');
    const ts = parseInt(getStoredSessionValue(prefix, 'AuthTs') || '0', 10);
    if (!auth || !ts) return false;
    if (Date.now() - ts > getSessionTimeoutMs(prefix)) {
      clearSession(prefix);
      return false;
    }
    return true;
  }

  async function hasServerSession(role) {
    const sessionRole = role === 'admin' ? 'admin' : role === 'viewer' ? 'viewer' : 'dashboard';
    try {
      const res = await fetch('/api/auth?session=1&role=' + encodeURIComponent(sessionRole), {
        credentials: 'same-origin',
      });
      if (!res.ok) return false;
      if (sessionRole === 'viewer') {
        const json = await res.json().catch(() => null);
        if (json && json.cabang) setViewerCabangSession(json.cabang);
      }
      return true;
    } catch {
      return null;
    }
  }

  function setSessionState(prefix, options = {}) {
    const remember = !!options.remember;
    const timestamp = String(Date.now());
    const entries = [
      ['Auth', '1'],
      ['AuthTs', timestamp],
      ['Token', options.token || ''],
    ];

    if (remember) entries.push(['AuthRemember', '1']);
    if (prefix === 'viewer') entries.push(['Cabang', options.cabang || '']);

    clearSession(prefix);

    entries.forEach(([suffix, value]) => {
      const key = getSessionKey(prefix, suffix);
      sessionStorage.setItem(key, value);
      if (remember) localStorage.setItem(key, value);
    });
  }

  function setViewerCabangSession(cabang) {
    const nextCabang = cabang || '';
    sessionStorage.setItem('viewerCabang', nextCabang);
    if (getStoredSessionValue('viewer', 'AuthRemember') === '1') {
      localStorage.setItem('viewerCabang', nextCabang);
    }
  }

  function getRememberChoice(role) {
    const prefix = role === 'admin' ? 'admin' : role === 'viewer' ? 'viewer' : 'dash';
    return localStorage.getItem(prefix + 'RememberChoice') === '1'
      || getStoredSessionValue(prefix, 'AuthRemember') === '1';
  }

  function setRememberChoice(role, remember) {
    const prefix = role === 'admin' ? 'admin' : role === 'viewer' ? 'viewer' : 'dash';
    localStorage.setItem(prefix + 'RememberChoice', remember ? '1' : '0');
  }

  function clearConflictingWorkspaceSessions(role) {
    if (role === 'viewer') {
      clearSession('admin');
      clearSession('dash');
      return;
    }

    if (role === 'admin') {
      clearSession('viewer');
      clearSession('dash');
      return;
    }

    clearSession('viewer');
    clearSession('admin');
  }

  function setActiveRole(role, remember = false) {
    if (role === 'admin') {
      clearConflictingWorkspaceSessions('admin');
      setSessionState('admin', { remember });
      return;
    }

    clearConflictingWorkspaceSessions('dashboard');
    setSessionState('dash', { remember });
  }

  function setLoginCopy(role) {
    const title = document.getElementById('loginTitle');
    const sub = document.getElementById('loginSub');
    if (!title || !sub) return;

    if (role === 'admin') {
      title.textContent = 'Maulagi Admin';
      sub.textContent = 'Password admin untuk upload, edit, dan pengaturan';
      return;
    }

    title.textContent = 'Maulagi Dashboard';
    sub.textContent = 'Password dashboard untuk lihat dan download';
  }

  async function openDashboard(targetTab, role) {
    loginMode = role === 'admin' ? 'admin' : 'dashboard';
    const requestedTargetTab = targetTab || 'dashboard';
    dashboardTargetTab = loginMode === 'admin' && requestedTargetTab === 'dashboard'
      ? 'admin'
      : requestedTargetTab;
    const component = loginMode === 'admin' ? 'admin-login-gate' : 'dashboard-login-gate';
    const prepWatch = startOpsWatch('Persiapan login lebih dari 10 detik', {
      action: 'login_prepare_stalled',
      component,
      timeoutMs: 10000,
    });

    try {
      const prefix = loginMode === 'admin' ? 'admin' : 'dash';
      const pwKey = loginMode === 'admin' ? 'admin_password' : 'dashboard_password';

      if (hasValidSession(prefix)) {
        const serverSession = await hasServerSession(loginMode);
        if (serverSession !== false) {
          location.href = '/dashboard.html#' + dashboardTargetTab;
          return;
        }
        clearSession(prefix);
      }

      clearSession(prefix);

      const res = await fetch('/api/auth?key=' + encodeURIComponent(pwKey), {
        credentials: 'same-origin',
      });
      const json = await res.json();
      if (!json.hasPassword) {
        setActiveRole(loginMode);
        location.href = '/dashboard.html#' + dashboardTargetTab;
        return;
      }
    } catch {
      reportOpsError('Gagal menyiapkan login', {
        action: 'login_prepare',
        component,
      });
      // Tetap tampilkan popup jika cek status password gagal.
    } finally {
      if (prepWatch) prepWatch.stop();
    }

    setLoginCopy(loginMode);
    const loginPw = document.getElementById('loginPw');
    const loginErr = document.getElementById('loginErr');
    const loginGate = document.getElementById('loginGate');
    const loginRemember = document.getElementById('loginRemember');
    if (!loginPw || !loginErr || !loginGate) return;

    loginPw.value = '';
    loginErr.textContent = '';
    if (loginRemember) loginRemember.checked = getRememberChoice(loginMode);
    loginGate.classList.add('show');
    setTimeout(() => loginPw.focus(), 50);
  }

  async function openViewerEntry() {
    if (hasValidSession('viewer')) {
      const serverSession = await hasServerSession('viewer');
      if (serverSession !== false) {
        clearConflictingWorkspaceSessions('viewer');
        location.href = '/dashboard.html#viewer';
        return;
      }
      clearSession('viewer');
    }

    openViewerLogin();
  }

  function openRekapPicker() {
    const input = document.getElementById('inpCabang');
    const popCabang = document.getElementById('popCabang');
    const cabangList = document.getElementById('cabangList');
    if (!input || !popCabang || !cabangList) return;

    input.value = '';
    popCabang.classList.add('show');
    document.body.style.overflow = 'hidden';

    if (allCabang) {
      renderCabangList('');
      setTimeout(() => input.focus(), 80);
      return;
    }

    cabangList.innerHTML = '<div class="cabang-loading"><i class="bi bi-arrow-repeat spin"></i> Memuat...</div>';

    fetch('/api/cabang', { credentials: 'same-origin' })
      .then((response) => {
        if (!response.ok) throw new Error(String(response.status));
        return response.json();
      })
      .then((data) => {
        allCabang = ((data && data.cabang) || []).sort((a, b) => {
          return (a.area || '').localeCompare(b.area || '') || a.nama.localeCompare(b.nama);
        });
        renderCabangList('');
        setTimeout(() => input.focus(), 80);
      })
      .catch(() => {
        cabangList.innerHTML = '<div class="cabang-loading"><i class="bi bi-exclamation-circle text-danger me-1"></i> Gagal memuat data</div>';
      });
  }

  function closePop() {
    const popCabang = document.getElementById('popCabang');
    if (!popCabang) return;
    popCabang.classList.remove('show');
    document.body.style.overflow = '';
  }

  function renderCabangList(query) {
    const el = document.getElementById('cabangList');
    if (!el) return;

    const normalizedQuery = String(query || '').toLowerCase();
    const list = (allCabang || []).filter((cabang) => {
      return !normalizedQuery || cabang.nama.toLowerCase().includes(normalizedQuery);
    });

    if (!list.length) {
      el.innerHTML = '<div class="cabang-loading">Tidak ditemukan</div>';
      return;
    }

    const groups = {};
    list.forEach((cabang) => {
      const area = cabang.area || 'Lainnya';
      if (!groups[area]) groups[area] = [];
      groups[area].push(cabang);
    });

    let html = '';
    for (const area in groups) {
      html += '<div class="area-label"><i class="bi bi-geo-fill me-1"></i>' + esc(area) + '</div>';
      html += groups[area].map((cabang) => {
        return '<a class="cabang-item" href="/rekap.html?cabang=' + escName(cabang.nama) + '">' +
          '<div class="ci-icon"><i class="bi bi-geo-alt-fill"></i></div>' +
          '<div>' +
            '<div class="ci-name">' + esc(cabang.nama) + '</div>' +
            '<div class="ci-area">' + esc(cabang.area || '-') + '</div>' +
          '</div>' +
        '</a>';
      }).join('');
    }

    el.innerHTML = html;
  }

  function escName(value) {
    return encodeURIComponent(value).replace(/'/g, '%27');
  }

  function esc(value) {
    const el = document.createElement('span');
    el.textContent = value;
    return el.innerHTML;
  }

  function clearLoginError() {
    const err = document.getElementById('loginErr');
    if (err) err.textContent = '';
  }

  function closeLoginGate() {
    const loginGate = document.getElementById('loginGate');
    const loginPw = document.getElementById('loginPw');
    const loginErr = document.getElementById('loginErr');
    if (!loginGate || !loginPw || !loginErr) return;

    loginGate.classList.remove('show');
    loginPw.value = '';
    loginErr.textContent = '';
  }

  function handleOverlayClick(event) {
    if (event.target === document.getElementById('loginGate')) {
      closeLoginGate();
    }
  }

  async function doLogin() {
    const pw = document.getElementById('loginPw');
    const errEl = document.getElementById('loginErr');
    const btn = document.getElementById('btnLogin');
    const rememberEl = document.getElementById('loginRemember');
    if (!pw || !errEl || !btn) return;

    if (!pw.value) {
      errEl.textContent = 'Masukkan password';
      return;
    }

    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Memverifikasi...';

    const pwKey = loginMode === 'dashboard' ? 'dashboard_password' : 'admin_password';
    const component = loginMode === 'admin' ? 'admin-login-gate' : 'dashboard-login-gate';
    const remember = !!(rememberEl && rememberEl.checked);
    const loginWatch = startOpsWatch('Verifikasi login lebih dari 10 detik', {
      action: 'login_verify_stalled',
      component,
      timeoutMs: 10000,
    });

    try {
      const res = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ action: 'verify', password: pw.value, key: pwKey, remember }),
      });
      const json = await res.json();
      if (!res.ok) {
        errEl.textContent = json.error || 'Password salah';
        btn.innerHTML = '<i class="bi bi-unlock-fill me-1"></i>Masuk';
        btn.disabled = false;
        pw.select();
        return;
      }

      setRememberChoice(loginMode, remember);
      setActiveRole(loginMode, remember);
      location.href = '/dashboard.html#' + dashboardTargetTab;
    } catch {
      reportOpsError('Verifikasi login gagal', {
        action: 'login_verify',
        component,
      });
      errEl.textContent = 'Kesalahan jaringan, coba lagi';
      btn.innerHTML = '<i class="bi bi-unlock-fill me-1"></i>Masuk';
      btn.disabled = false;
    } finally {
      if (loginWatch) loginWatch.stop();
    }
  }

  function openViewerLogin() {
    const gate = document.getElementById('viewerLoginGate');
    const wa = document.getElementById('viewerWa');
    const pw = document.getElementById('viewerPw');
    const err = document.getElementById('viewerErr');
    const rememberEl = document.getElementById('viewerRemember');
    if (!gate) return;
    const remember = getRememberChoice('viewer');
    if (wa) wa.value = remember ? (localStorage.getItem('viewerLastWa') || '') : '';
    if (pw) pw.value = '';
    if (rememberEl) rememberEl.checked = remember;
    if (err) err.textContent = '';
    gate.classList.add('show');
    setTimeout(() => { if (wa) wa.focus(); }, 50);
  }

  function closeViewerLoginGate() {
    const gate = document.getElementById('viewerLoginGate');
    if (gate) gate.classList.remove('show');
  }

  async function doViewerLogin() {
    const wa = document.getElementById('viewerWa');
    const pw = document.getElementById('viewerPw');
    const err = document.getElementById('viewerErr');
    const btn = document.getElementById('btnViewerLogin');
    const rememberEl = document.getElementById('viewerRemember');
    if (!wa || !pw || !err || !btn) return;

    const waVal = wa.value.trim();
    const pwVal = pw.value;
    const remember = !!(rememberEl && rememberEl.checked);
    if (!waVal) { err.textContent = 'Masukkan nomor WhatsApp'; wa.focus(); return; }
    if (!pwVal) { err.textContent = 'Masukkan password'; pw.focus(); return; }

    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Memverifikasi...';

    const loginWatch = startOpsWatch('Verifikasi viewer login lebih dari 10 detik', {
      action: 'viewer_login_stalled',
      timeoutMs: 10000,
    });

    try {
      const res = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ action: 'verify_viewer', no_wa: waVal, password: pwVal, remember }),
      });
      const json = await res.json();
      if (!res.ok) {
        err.textContent = json.error || 'Nomor WA atau password salah';
        btn.innerHTML = '<i class="bi bi-box-arrow-in-right me-1"></i>Masuk';
        btn.disabled = false;
        pw.value = '';
        pw.focus();
        return;
      }

      setRememberChoice('viewer', remember);
      if (remember) localStorage.setItem('viewerLastWa', waVal);
      else localStorage.removeItem('viewerLastWa');
      clearConflictingWorkspaceSessions('viewer');
      setSessionState('viewer', { remember, cabang: json.cabang || '' });
      location.href = '/dashboard.html#viewer';
    } catch {
      reportOpsError('Viewer login gagal', { action: 'viewer_login' });
      err.textContent = 'Kesalahan jaringan, coba lagi';
      btn.innerHTML = '<i class="bi bi-box-arrow-in-right me-1"></i>Masuk';
      btn.disabled = false;
    } finally {
      if (loginWatch) loginWatch.stop();
    }
  }

  function loadVisitorCount() {
    let visitorId = localStorage.getItem('dash_vid');
    if (!visitorId) {
      visitorId = Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
      localStorage.setItem('dash_vid', visitorId);
    }

    const lastVisit = parseInt(localStorage.getItem('dash_vts') || '0', 10);
    const cachedCount = localStorage.getItem('dash_vcount');
    const visitorToday = document.getElementById('visitorToday');
    if (!visitorToday) return;

    if (Date.now() - lastVisit > 5 * 60 * 1000) {
      localStorage.setItem('dash_vts', String(Date.now()));
      fetch('/api/dashboard?visit=1&vid=' + encodeURIComponent(visitorId), { credentials: 'same-origin' })
        .then((response) => response.json())
        .then((data) => {
          const count = parseInt(data.today, 10);
          const display = Number.isNaN(count) ? '-' : count;
          visitorToday.textContent = String(display);
          localStorage.setItem('dash_vcount', String(display));
        })
        .catch(() => {
          visitorToday.textContent = cachedCount || '-';
        });
      return;
    }

    visitorToday.textContent = cachedCount || '...';
  }
})();
