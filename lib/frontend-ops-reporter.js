(function () {
  const FRONTEND_LOG_ENDPOINT = '/api/frontend-log';
  const MAX_REPORTS = 3;
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

  function normalizeText(value, maxLength) {
    return String(value || '').trim().slice(0, maxLength || 1000);
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

  window.FrontendOpsReporter = {
    report,
    reportMessage(message, meta) {
      report(message, meta || {});
    },
    watch,
  };
})();
