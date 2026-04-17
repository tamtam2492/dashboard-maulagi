const SESSION_COOKIE_NAMES = {
  admin: 'maulagi_admin_session',
  dashboard: 'maulagi_dashboard_session',
};
const SESSION_SAME_SITE = 'Strict';

function getSessionCookieName(role) {
  return SESSION_COOKIE_NAMES[role] || '';
}

function parseCookies(headerValue) {
  return String(headerValue || '')
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((acc, part) => {
      const separatorIndex = part.indexOf('=');
      if (separatorIndex === -1) return acc;
      const key = part.slice(0, separatorIndex).trim();
      const value = part.slice(separatorIndex + 1).trim();
      if (!key) return acc;
      acc[key] = decodeURIComponent(value || '');
      return acc;
    }, {});
}

function readSessionCookies(req, roles = ['admin', 'dashboard']) {
  const cookies = parseCookies(req && req.headers ? req.headers.cookie : '');
  return roles
    .map((role) => ({ role, token: cookies[getSessionCookieName(role)] || '' }))
    .filter((entry) => entry.token);
}

function isSecureRequest(req) {
  const forwardedProto = String(req && req.headers ? (req.headers['x-forwarded-proto'] || '') : '')
    .split(',')[0]
    .trim();
  return forwardedProto === 'https' || !!process.env.VERCEL_URL || process.env.NODE_ENV === 'production';
}

function buildCookieString(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value || '')}`];
  parts.push(`Path=${options.path || '/'}`);

  if (options.maxAge != null) {
    parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAge))}`);
  }
  if (options.httpOnly !== false) {
    parts.push('HttpOnly');
  }
  if (options.sameSite) {
    parts.push(`SameSite=${options.sameSite}`);
  }
  if (options.secure) {
    parts.push('Secure');
  }

  return parts.join('; ');
}

function appendSetCookie(res, cookieValue) {
  const existing = res.getHeader('Set-Cookie');
  if (!existing) {
    res.setHeader('Set-Cookie', [cookieValue]);
    return;
  }
  if (Array.isArray(existing)) {
    res.setHeader('Set-Cookie', [...existing, cookieValue]);
    return;
  }
  res.setHeader('Set-Cookie', [existing, cookieValue]);
}

function setSessionCookie(res, role, token, req, maxAgeSeconds = 60 * 60) {
  const cookieName = getSessionCookieName(role);
  if (!cookieName || !token) return;
  appendSetCookie(res, buildCookieString(cookieName, token, {
    maxAge: maxAgeSeconds,
    httpOnly: true,
    sameSite: SESSION_SAME_SITE,
    secure: isSecureRequest(req),
    path: '/',
  }));
}

function clearSessionCookie(res, role, req) {
  const cookieName = getSessionCookieName(role);
  if (!cookieName) return;
  appendSetCookie(res, buildCookieString(cookieName, '', {
    maxAge: 0,
    httpOnly: true,
    sameSite: SESSION_SAME_SITE,
    secure: isSecureRequest(req),
    path: '/',
  }));
}

function clearAllSessionCookies(res, req) {
  clearSessionCookie(res, 'admin', req);
  clearSessionCookie(res, 'dashboard', req);
}

module.exports = {
  clearAllSessionCookies,
  clearSessionCookie,
  getSessionCookieName,
  parseCookies,
  readSessionCookies,
  setSessionCookie,
};