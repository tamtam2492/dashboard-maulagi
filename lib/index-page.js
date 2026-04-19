(function () {
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

    const rekapCard = document.getElementById('rekapCard');
    if (rekapCard) {
      rekapCard.addEventListener('click', (event) => {
        event.preventDefault();
        openRekapPicker();
      });
    }

    const viewerCard = document.getElementById('viewerCard');
    if (viewerCard) {
      viewerCard.addEventListener('click', () => openViewerLogin());
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

    openViewerLogin();

    try {
      const nextUrl = location.pathname + (location.hash || '');
      window.history.replaceState({}, document.title, nextUrl);
    } catch {}
  }

  function hasValidSession(prefix) {
    const ts = parseInt(sessionStorage.getItem(prefix + 'AuthTs') || '0', 10);
    return !!sessionStorage.getItem(prefix + 'Auth') && ts && (Date.now() - ts <= 60 * 60 * 1000);
  }

  async function hasServerSession(role) {
    const sessionRole = role === 'admin' ? 'admin' : 'dashboard';
    try {
      const res = await fetch('/api/auth?session=1&role=' + encodeURIComponent(sessionRole), {
        credentials: 'same-origin',
      });
      return res.ok;
    } catch {
      return null;
    }
  }

  function clearSession(prefix) {
    sessionStorage.removeItem(prefix + 'Auth');
    sessionStorage.removeItem(prefix + 'AuthTs');
    sessionStorage.removeItem(prefix + 'Token');
  }

  function setActiveRole(role) {
    if (role === 'admin') {
      clearSession('dash');
      sessionStorage.setItem('adminAuth', '1');
      sessionStorage.setItem('adminAuthTs', String(Date.now()));
      sessionStorage.setItem('adminToken', '');
      return;
    }

    clearSession('admin');
    sessionStorage.setItem('dashAuth', '1');
    sessionStorage.setItem('dashAuthTs', String(Date.now()));
    sessionStorage.setItem('dashToken', '');
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
    if (!loginPw || !loginErr || !loginGate) return;

    loginPw.value = '';
    loginErr.textContent = '';
    loginGate.classList.add('show');
    setTimeout(() => loginPw.focus(), 50);
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
    if (!pw || !errEl || !btn) return;

    if (!pw.value) {
      errEl.textContent = 'Masukkan password';
      return;
    }

    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Memverifikasi...';

    const pwKey = loginMode === 'dashboard' ? 'dashboard_password' : 'admin_password';
    const component = loginMode === 'admin' ? 'admin-login-gate' : 'dashboard-login-gate';
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
        body: JSON.stringify({ action: 'verify', password: pw.value, key: pwKey }),
      });
      const json = await res.json();
      if (!res.ok) {
        errEl.textContent = json.error || 'Password salah';
        btn.innerHTML = '<i class="bi bi-unlock-fill me-1"></i>Masuk';
        btn.disabled = false;
        pw.select();
        return;
      }

      setActiveRole(loginMode);
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
    if (!gate) return;
    if (wa) wa.value = '';
    if (pw) pw.value = '';
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
    if (!wa || !pw || !err || !btn) return;

    const waVal = wa.value.trim();
    const pwVal = pw.value;
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
        body: JSON.stringify({ action: 'verify_viewer', no_wa: waVal, password: pwVal }),
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

      sessionStorage.setItem('viewerAuth', '1');
      sessionStorage.setItem('viewerAuthTs', String(Date.now()));
      sessionStorage.setItem('viewerCabang', json.cabang || '');
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
