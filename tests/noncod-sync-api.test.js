const test = require('node:test');
const assert = require('node:assert/strict');

const handler = require('../api/noncod');

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

test('noncod-sync menolak secret yang salah', async () => {
  const previousSecret = process.env.NONCOD_SYNC_SECRET;
  process.env.NONCOD_SYNC_SECRET = 'server-secret';

  try {
    const req = {
      method: 'POST',
      url: '/api/noncod-sync',
      query: { pipeline: '1' },
      headers: {
        'x-forwarded-for': '10.0.0.1',
        'x-sync-secret': 'wrong-secret',
      },
      body: { reason: 'manual' },
    };
    const res = createResponse();

    await handler(req, res);

    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.body, { error: 'Unauthorized.' });
  } finally {
    process.env.NONCOD_SYNC_SECRET = previousSecret;
  }
});

test('timingSafeSecretEqual helper noncod-sync hanya true untuk secret yang sama', () => {
  assert.equal(handler.timingSafeSecretEqual('abc123', 'abc123'), true);
  assert.equal(handler.timingSafeSecretEqual('abc123', 'abc124'), false);
});