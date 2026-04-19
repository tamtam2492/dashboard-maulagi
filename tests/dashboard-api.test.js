const test = require('node:test');
const assert = require('node:assert/strict');

const handler = require('../api/dashboard');

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

test('dashboard menolak POST ke route watch', async () => {
  const req = {
    method: 'POST',
    url: '/api/dashboard?watch=1',
    query: { watch: '1' },
    headers: {},
  };
  const res = createResponse();

  await handler(req, res);

  assert.equal(res.statusCode, 405);
  assert.deepEqual(res.body, { error: 'Method not allowed.' });
});

test('dashboard menolak POST ke route utama', async () => {
  const req = {
    method: 'POST',
    url: '/api/dashboard',
    query: {},
    headers: {},
  };
  const res = createResponse();

  await handler(req, res);

  assert.equal(res.statusCode, 405);
  assert.deepEqual(res.body, { error: 'Method not allowed.' });
});