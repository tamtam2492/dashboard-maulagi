const test = require('node:test');
const assert = require('node:assert/strict');

const frontendLogHandler = require('../api/frontend-log');

const { isTrustedFrontendRequest, isNonErrorFrontendAction } = frontendLogHandler;

function createResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
    end() {
      return this;
    },
  };
}

test('isTrustedFrontendRequest menerima same-origin request dari host aktif', () => {
  const req = {
    headers: {
      host: 'dashboard-transfer-maulagi.vercel.app',
      origin: 'https://dashboard-transfer-maulagi.vercel.app',
      referer: 'https://dashboard-transfer-maulagi.vercel.app/dashboard.html#admin',
      'x-forwarded-proto': 'https',
    },
  };

  assert.equal(isTrustedFrontendRequest(req), true);
});

test('isTrustedFrontendRequest menolak cross-origin request', () => {
  const req = {
    headers: {
      host: 'dashboard-transfer-maulagi.vercel.app',
      origin: 'https://evil.example.com',
      referer: 'https://evil.example.com/hijack',
      'x-forwarded-proto': 'https',
    },
  };

  assert.equal(isTrustedFrontendRequest(req), false);
});

test('isTrustedFrontendRequest menerima same-origin fetch metadata untuk beacon', () => {
  const req = {
    headers: {
      host: 'dashboard-transfer-maulagi.vercel.app',
      'x-forwarded-proto': 'https',
      'sec-fetch-site': 'same-origin',
      'sec-fetch-mode': 'no-cors',
    },
  };

  assert.equal(isTrustedFrontendRequest(req), true);
});

test('isTrustedFrontendRequest tetap menolak fetch metadata cross-site', () => {
  const req = {
    headers: {
      host: 'dashboard-transfer-maulagi.vercel.app',
      'x-forwarded-proto': 'https',
      'sec-fetch-site': 'cross-site',
      'sec-fetch-mode': 'no-cors',
    },
  };

  assert.equal(isTrustedFrontendRequest(req), false);
});

test('isNonErrorFrontendAction mengenali smoke test operasional', () => {
  assert.equal(isNonErrorFrontendAction(' smoke_test '), true);
  assert.equal(isNonErrorFrontendAction('window_error'), false);
});

test('frontend-log menerima smoke_test tanpa memicu jalur error produksi', async () => {
  const req = {
    method: 'POST',
    headers: {
      host: 'dashboard-transfer-maulagi.vercel.app',
      origin: 'https://dashboard-transfer-maulagi.vercel.app',
      referer: 'https://dashboard-transfer-maulagi.vercel.app/dashboard.html',
      'x-forwarded-proto': 'https',
    },
    body: {
      source: 'frontend-dashboard',
      message: 'smoke frontend log',
      path: '/dashboard.html',
      url: 'https://dashboard-transfer-maulagi.vercel.app/dashboard.html',
      action: 'smoke_test',
    },
  };
  const res = createResponse();

  await frontendLogHandler(req, res);

  assert.equal(res.statusCode, 202);
  assert.deepEqual(res.body, { ok: true, skipped: true, reason: 'smoke_test' });
});
