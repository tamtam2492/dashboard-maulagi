const test = require('node:test');
const assert = require('node:assert/strict');

const {
  clearAllSessionCookies,
  getSessionCookieName,
  parseCookies,
  readSessionCookies,
  setSessionCookie,
} = require('../api/_session-cookie');

function createMockResponse() {
  const headers = {};
  return {
    getHeader(name) {
      return headers[name];
    },
    setHeader(name, value) {
      headers[name] = value;
    },
    headers,
  };
}

test('parseCookies membaca cookie header sederhana', () => {
  const cookies = parseCookies('foo=bar; maulagi_admin_session=token123; sample=value%202');
  assert.equal(cookies.foo, 'bar');
  assert.equal(cookies.maulagi_admin_session, 'token123');
  assert.equal(cookies.sample, 'value 2');
});

test('readSessionCookies memilih cookie sesuai role', () => {
  const req = {
    headers: {
      cookie: 'maulagi_dashboard_session=dash-token; maulagi_admin_session=admin-token',
    },
  };

  const adminOnly = readSessionCookies(req, ['admin']);
  assert.equal(adminOnly.length, 1);
  assert.equal(adminOnly[0].role, 'admin');
  assert.equal(adminOnly[0].token, 'admin-token');

  const allRoles = readSessionCookies(req, ['admin', 'dashboard']);
  assert.equal(allRoles.length, 2);
});

test('setSessionCookie dan clearAllSessionCookies mengelola header Set-Cookie', () => {
  const res = createMockResponse();
  const req = { headers: { 'x-forwarded-proto': 'https' } };

  setSessionCookie(res, 'admin', 'token-abc', req, 3600);
  clearAllSessionCookies(res, req);

  const cookies = res.headers['Set-Cookie'];
  assert.ok(Array.isArray(cookies));
  assert.ok(cookies.some((value) => value.includes(getSessionCookieName('admin') + '=token-abc')));
  assert.ok(cookies.some((value) => value.includes(getSessionCookieName('admin') + '=') && value.includes('Max-Age=0')));
  assert.ok(cookies.some((value) => value.includes(getSessionCookieName('dashboard') + '=') && value.includes('Max-Age=0')));
  assert.ok(cookies.every((value) => value.includes('HttpOnly')));
  assert.ok(cookies.every((value) => value.includes('SameSite=Strict')));
});