const test = require('node:test');
const assert = require('node:assert/strict');

const {
  shouldRememberSession,
  getSessionMaxAgeSeconds,
} = require('../api/auth');

test('shouldRememberSession mengenali nilai remember yang valid', () => {
  assert.equal(shouldRememberSession(true), true);
  assert.equal(shouldRememberSession(1), true);
  assert.equal(shouldRememberSession('1'), true);
  assert.equal(shouldRememberSession('true'), true);
  assert.equal(shouldRememberSession(' TRUE '), true);
});

test('shouldRememberSession menolak nilai remember yang tidak valid', () => {
  assert.equal(shouldRememberSession(false), false);
  assert.equal(shouldRememberSession(0), false);
  assert.equal(shouldRememberSession('0'), false);
  assert.equal(shouldRememberSession('false'), false);
  assert.equal(shouldRememberSession(''), false);
  assert.equal(shouldRememberSession(null), false);
});

test('getSessionMaxAgeSeconds memilih 30 hari saat remember aktif', () => {
  assert.equal(getSessionMaxAgeSeconds(true), 30 * 24 * 60 * 60);
  assert.equal(getSessionMaxAgeSeconds('1'), 30 * 24 * 60 * 60);
});

test('getSessionMaxAgeSeconds fallback ke 1 jam saat remember nonaktif', () => {
  assert.equal(getSessionMaxAgeSeconds(false), 60 * 60);
  assert.equal(getSessionMaxAgeSeconds('false'), 60 * 60);
  assert.equal(getSessionMaxAgeSeconds(undefined), 60 * 60);
});