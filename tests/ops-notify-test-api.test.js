const test = require('node:test');
const assert = require('node:assert/strict');

const handler = require('../api/auth');

function createResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    ended: false,
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
      this.ended = true;
      return this;
    },
  };
}

test('timingSafeSecretEqual hanya true untuk secret yang sama', () => {
  assert.equal(handler.timingSafeSecretEqual('abc123', 'abc123'), true);
  assert.equal(handler.timingSafeSecretEqual('abc123', 'abc124'), false);
  assert.equal(handler.timingSafeSecretEqual('abc123', ''), false);
});

test('ops-notify-test menolak secret yang salah', async () => {
  const previousSecret = process.env.TELEGRAM_NOTIFY_SECRET;
  process.env.TELEGRAM_NOTIFY_SECRET = 'server-secret';

  try {
    const req = {
      method: 'POST',
      url: '/api/auth?ops=logs&notify_test=1',
      query: { ops: 'logs', notify_test: '1' },
      headers: {
        'x-forwarded-for': '10.0.0.1',
        'x-ops-secret': 'wrong-secret',
      },
      body: { action: 'notify_test', source: 'dashboard' },
    };
    const res = createResponse();

    await handler(req, res);

    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.body, { error: 'Unauthorized.' });
  } finally {
    process.env.TELEGRAM_NOTIFY_SECRET = previousSecret;
  }
});

test('ops-notify-test menolak request tanpa secret', async () => {
  const previousSecret = process.env.TELEGRAM_NOTIFY_SECRET;
  process.env.TELEGRAM_NOTIFY_SECRET = 'server-secret';

  try {
    const req = {
      method: 'POST',
      url: '/api/auth?ops=logs&notify_test=1',
      query: { ops: 'logs', notify_test: '1' },
      headers: {
        'x-forwarded-for': '10.0.0.5',
      },
      body: { action: 'notify_test', source: 'dashboard' },
    };
    const res = createResponse();

    await handler(req, res);

    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.body, { error: 'Unauthorized.' });
  } finally {
    process.env.TELEGRAM_NOTIFY_SECRET = previousSecret;
  }
});

test('ops-notify-test meneruskan request ke Lambda saat secret valid', async () => {
  const previousEnv = {
    TELEGRAM_NOTIFY_URL: process.env.TELEGRAM_NOTIFY_URL,
    TELEGRAM_NOTIFY_SECRET: process.env.TELEGRAM_NOTIFY_SECRET,
    TELEGRAM_NOTIFY_SOURCES: process.env.TELEGRAM_NOTIFY_SOURCES,
    TELEGRAM_NOTIFY_SERVICE: process.env.TELEGRAM_NOTIFY_SERVICE,
  };
  const previousFetch = global.fetch;

  process.env.TELEGRAM_NOTIFY_URL = 'https://example.test/lambda';
  process.env.TELEGRAM_NOTIFY_SECRET = 'server-secret';
  process.env.TELEGRAM_NOTIFY_SOURCES = 'dashboard';
  process.env.TELEGRAM_NOTIFY_SERVICE = 'dashboard-maulagi-test';

  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, status: 200 };
  };

  try {
    const req = {
      method: 'POST',
      url: '/api/auth?ops=logs&notify_test=1',
      query: { ops: 'logs', notify_test: '1' },
      headers: {
        'x-forwarded-for': '10.0.0.2',
        'x-ops-secret': 'server-secret',
      },
      body: {
        action: 'notify_test',
        source: 'dashboard',
        title: 'Smoke test',
        message: 'Tes notifier dari unit test.',
      },
    };
    const res = createResponse();

    await handler(req, res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { success: true, source: 'dashboard', status: 200 });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://example.test/lambda');
    assert.equal(calls[0].options.method, 'POST');
    assert.equal(calls[0].options.headers['X-Ops-Secret'], 'server-secret');
  } finally {
    process.env.TELEGRAM_NOTIFY_URL = previousEnv.TELEGRAM_NOTIFY_URL;
    process.env.TELEGRAM_NOTIFY_SECRET = previousEnv.TELEGRAM_NOTIFY_SECRET;
    process.env.TELEGRAM_NOTIFY_SOURCES = previousEnv.TELEGRAM_NOTIFY_SOURCES;
    process.env.TELEGRAM_NOTIFY_SERVICE = previousEnv.TELEGRAM_NOTIFY_SERVICE;
    global.fetch = previousFetch;
  }
});