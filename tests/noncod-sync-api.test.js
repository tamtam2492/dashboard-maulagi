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

test('noncod pipeline route manual dinonaktifkan', async () => {
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

  assert.equal(res.statusCode, 410);
  assert.deepEqual(res.body, {
    error: 'Route sync MauKirim NONCOD sudah dinonaktifkan. Gunakan upload workbook manual.',
  });
});

test('noncod route utama meminta auth admin untuk upload workbook manual', async () => {
  const req = {
    method: 'POST',
    url: '/api/noncod',
    query: {},
    headers: {},
  };
  const res = createResponse();

  await handler(req, res);

  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { error: 'Token diperlukan.' });
});

test('noncod menolak method di luar allowlist sebelum menyentuh flow lain', async () => {
  const req = {
    method: 'PATCH',
    url: '/api/noncod',
    query: {},
    headers: {},
  };
  const res = createResponse();

  await handler(req, res);

  assert.equal(res.statusCode, 405);
  assert.deepEqual(res.body, { error: 'Method not allowed.' });
});