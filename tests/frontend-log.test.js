const test = require('node:test');
const assert = require('node:assert/strict');

const frontendLogHandler = require('../api/frontend-log');

const { isTrustedFrontendRequest } = frontendLogHandler;

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
