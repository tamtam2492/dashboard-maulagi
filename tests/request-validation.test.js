const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ensureAllowedMethod,
  normalizeBoundedInt,
  normalizeQueryFlag,
  normalizeRequestMethod,
  normalizeText,
} = require('../api/_request-validation');

function createResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

test('normalizeText merapikan string dan memotong panjang maksimum', () => {
  assert.equal(normalizeText('  abc  ', 10), 'abc');
  assert.equal(normalizeText('0123456789XYZ', 5), '01234');
});

test('normalizeRequestMethod mengubah method ke uppercase aman', () => {
  assert.equal(normalizeRequestMethod(' post '), 'POST');
  assert.equal(normalizeRequestMethod(null), '');
});

test('normalizeQueryFlag hanya true untuk flag 1', () => {
  assert.equal(normalizeQueryFlag('1'), true);
  assert.equal(normalizeQueryFlag('0'), false);
  assert.equal(normalizeQueryFlag(' true '), false);
});

test('normalizeBoundedInt memakai fallback lalu clamp ke rentang aman', () => {
  assert.equal(normalizeBoundedInt(undefined, { fallback: 100, min: 1, max: 500 }), 100);
  assert.equal(normalizeBoundedInt('-5', { fallback: 100, min: 1, max: 500 }), 1);
  assert.equal(normalizeBoundedInt('9999', { fallback: 100, min: 1, max: 500 }), 500);
  assert.equal(normalizeBoundedInt('250', { fallback: 100, min: 1, max: 500 }), 250);
});

test('ensureAllowedMethod menolak method di luar allowlist', () => {
  const res = createResponse();
  const allowed = ensureAllowedMethod({ method: 'POST' }, res, ['GET']);

  assert.equal(allowed, false);
  assert.equal(res.statusCode, 405);
  assert.deepEqual(res.body, { error: 'Method not allowed.' });
});