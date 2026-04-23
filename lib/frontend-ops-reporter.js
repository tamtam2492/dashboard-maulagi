(function () {
  const FRONTEND_LOG_ENDPOINT = '/api/frontend-log';
  const APP_VERSION_ENDPOINT = '/api/version';
  const MAX_REPORTS = 3;
  const UPDATE_CHECK_INTERVAL_MS = 60000;
  const UPDATE_CHECK_FOCUS_DEBOUNCE_MS = 15000;
  const UPDATE_BANNER_ID = 'frontendUpdateBanner';
  const UPDATE_BANNER_STYLE_ID = 'frontendUpdateBannerStyle';
  const PAGE_SOURCE_MAP = {
    '/': 'frontend-index',
    '/index.html': 'frontend-index',
    '/dashboard.html': 'frontend-dashboard',
    '/admin.html': 'frontend-admin',
    '/input.html': 'frontend-input',
    '/noncod.html': 'frontend-noncod',
    '/rekap.html': 'frontend-rekap',
  };

  let sentCount = 0;
  let isSending = false;
  let pageBuildId = '';
  let pendingBuildId = '';
  let updateCheckPromise = null;
  let lastUpdateCheckAt = 0;

  function normalizeText(value, maxLength) {
    return String(value || '').trim().slice(0, maxLength || 1000);
  }

  function shouldSkipVersionCheck() {
    return typeof window.fetch !== 'function' || location.protocol === 'file:';
  }

  function getSource() {
    const path = normalizeText(location.pathname, 120) || '/';
    return PAGE_SOURCE_MAP[path] || 'frontend-dashboard';
  }

  function buildPayload(message, meta) {
    return {
      source: getSource(),
      message: normalizeText(message, 1200),
      path: normalizeText(location.pathname, 200),
      url: normalizeText(location.href, 400),
      action: normalizeText(meta && meta.action, 120),
      component: normalizeText(meta && meta.component, 120),
      line: meta && Number.isFinite(Number(meta.line)) ? Number(meta.line) : undefined,
      column: meta && Number.isFinite(Number(meta.column)) ? Number(meta.column) : undefined,
    };
  }

  function trySendBeacon(payload) {
    if (typeof navigator === 'undefined' || typeof navigator.sendBeacon !== 'function') return false;
    try {
      const body = JSON.stringify(payload);
      const blob = typeof Blob === 'function'
        ? new Blob([body], { type: 'application/json' })
        : body;
      return navigator.sendBeacon(FRONTEND_LOG_ENDPOINT, blob);
    } catch {
      return false;
    }
  }

  function sendPayload(payload) {
    if (!payload.message || sentCount >= MAX_REPORTS) return;

    if (trySendBeacon(payload)) {
      sentCount += 1;
      return;
    }

    if (isSending) return;
    sentCount += 1;
    isSending = true;

    fetch(FRONTEND_LOG_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      keepalive: true,
      body: JSON.stringify(payload),
    }).catch(() => {
      sentCount = Math.max(0, sentCount - 1);
    }).finally(() => {
      isSending = false;
    });
  }

  function extractErrorMessage(error, fallback) {
    if (error && typeof error === 'object' && normalizeText(error.message, 1200)) {
      return normalizeText(error.message, 1200);
    }
    if (typeof error === 'string' && normalizeText(error, 1200)) {
      return normalizeText(error, 1200);
    }
    return normalizeText(fallback, 1200) || 'Frontend error';
  }

  function report(error, meta) {
    const payload = buildPayload(extractErrorMessage(error, meta && meta.fallbackMessage), meta || {});
    sendPayload(payload);
  }

  function ensureUpdateBannerStyles() {
    if (document.getElementById(UPDATE_BANNER_STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = UPDATE_BANNER_STYLE_ID;
    style.textContent = [
      '#' + UPDATE_BANNER_ID + ' { position: fixed; left: 16px; right: 16px; bottom: 16px; z-index: 1080; display: none; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 16px; border-radius: 16px; background: rgba(20, 27, 45, 0.96); color: #f7f8fb; box-shadow: 0 16px 40px rgba(8, 12, 20, 0.28); font-family: inherit; }',
      '#' + UPDATE_BANNER_ID + '.show { display: flex; }',
      '#' + UPDATE_BANNER_ID + ' .update-copy { display: flex; flex-direction: column; gap: 2px; min-width: 0; }',
      '#' + UPDATE_BANNER_ID + ' .update-title { font-size: 0.95rem; font-weight: 700; }',
      '#' + UPDATE_BANNER_ID + ' .update-text { font-size: 0.82rem; line-height: 1.35; opacity: 0.92; }',
      '#' + UPDATE_BANNER_ID + ' .update-action { border: 0; border-radius: 999px; padding: 9px 16px; background: #f3c84b; color: #1a1f2b; font-weight: 700; white-space: nowrap; }',
      '#' + UPDATE_BANNER_ID + ' .update-action:focus-visible { outline: 2px solid #ffffff; outline-offset: 2px; }',
      '@media (max-width: 640px) { #' + UPDATE_BANNER_ID + ' { left: 12px; right: 12px; bottom: 12px; align-items: stretch; flex-direction: column; } #' + UPDATE_BANNER_ID + ' .update-action { width: 100%; } }',
    ].join('');
    document.head.appendChild(style);
  }

  function reloadForUpdate() {
    location.reload();
  }

  function ensureUpdateBanner() {
    if (!document.body) return null;
    ensureUpdateBannerStyles();
    let banner = document.getElementById(UPDATE_BANNER_ID);
    if (banner) return banner;

    banner = document.createElement('div');
    banner.id = UPDATE_BANNER_ID;
    banner.setAttribute('role', 'status');
    banner.setAttribute('aria-live', 'polite');
    banner.innerHTML =
      '<div class="update-copy">' +
        '<div class="update-title">Versi baru tersedia</div>' +
        '<div class="update-text">Perubahan sistem sudah siap. Tekan Muat Ulang agar halaman memakai aturan terbaru.</div>' +
      '</div>' +
      '<button type="button" class="update-action">Muat Ulang</button>';

    const button = banner.querySelector('.update-action');
    if (button) {
      button.addEventListener('click', reloadForUpdate);
    }

    document.body.appendChild(banner);
    return banner;
  }

  function showUpdateBanner() {
    const render = function () {
      const banner = ensureUpdateBanner();
      if (banner) banner.classList.add('show');
    };

    if (document.body) {
      render();
      return;
    }

    window.addEventListener('DOMContentLoaded', render, { once: true });
  }

  function handleVersionPayload(buildId) {
    const normalizedBuildId = normalizeText(buildId, 120);
    if (!normalizedBuildId) return;

    if (!pageBuildId) {
      pageBuildId = normalizedBuildId;
      pendingBuildId = '';
      return;
    }

    if (normalizedBuildId === pageBuildId) {
      pendingBuildId = '';
      return;
    }

    pendingBuildId = normalizedBuildId;
    showUpdateBanner();
  }

  async function fetchVersionPayload() {
    const response = await fetch(APP_VERSION_ENDPOINT + '?ts=' + Date.now(), {
      method: 'GET',
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) return null;
    return response.json();
  }

  function checkForAppUpdate(force) {
    if (shouldSkipVersionCheck()) return Promise.resolve(false);
    const now = Date.now();
    if (!force && now - lastUpdateCheckAt < UPDATE_CHECK_FOCUS_DEBOUNCE_MS) {
      return updateCheckPromise || Promise.resolve(Boolean(pendingBuildId));
    }
    if (updateCheckPromise) return updateCheckPromise;

    lastUpdateCheckAt = now;
    updateCheckPromise = fetchVersionPayload()
      .then((payload) => {
        handleVersionPayload(payload && payload.buildId);
        return Boolean(pendingBuildId);
      })
      .catch(() => Boolean(pendingBuildId))
      .finally(() => {
        updateCheckPromise = null;
      });

    return updateCheckPromise;
  }

  function startVersionMonitor() {
    if (shouldSkipVersionCheck()) return;
    void checkForAppUpdate(true);
    window.setInterval(function () {
      void checkForAppUpdate(false);
    }, UPDATE_CHECK_INTERVAL_MS);
    window.addEventListener('focus', function () {
      void checkForAppUpdate(false);
    });
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') {
        void checkForAppUpdate(false);
      }
    });
  }

  function watch(message, meta) {
    const options = meta && typeof meta === 'object' ? { ...meta } : {};
    const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 20000;
    let finished = false;
    let fired = false;
    const timerId = window.setTimeout(function () {
      if (finished) return;
      fired = true;
      report(message, {
        ...options,
        action: normalizeText(options.action, 120) || 'frontend_watchdog_timeout',
        fallbackMessage: normalizeText(message, 1200) || 'Frontend loading timeout',
        timeoutMs,
      });
    }, timeoutMs);

    return {
      stop() {
        finished = true;
        window.clearTimeout(timerId);
      },
      didFire() {
        return fired;
      },
    };
  }

  window.addEventListener('error', function (event) {
    if (!event) return;
    report(event.error || event.message || 'Unhandled window error', {
      action: 'window_error',
      component: normalizeText(event.filename, 120),
      line: event.lineno,
      column: event.colno,
      fallbackMessage: event.message || 'Unhandled window error',
    });
  });

  window.addEventListener('unhandledrejection', function (event) {
    const reason = event && 'reason' in event ? event.reason : null;
    report(reason, {
      action: 'unhandled_rejection',
      fallbackMessage: 'Unhandled promise rejection',
    });
  });

  startVersionMonitor();

  window.FrontendOpsReporter = {
    report,
    reportMessage(message, meta) {
      report(message, meta || {});
    },
    checkForAppUpdate(force) {
      return checkForAppUpdate(Boolean(force));
    },
    hasPendingUpdate() {
      return Boolean(pendingBuildId);
    },
    promptRefresh() {
      if (!pendingBuildId) return false;
      showUpdateBanner();
      return true;
    },
    reloadForUpdate,
    watch,
  };
})();
