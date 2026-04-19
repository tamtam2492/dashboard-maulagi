const test = require('node:test');
const assert = require('node:assert/strict');

const handler = require('../api/transfer');

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

test('transfer menolak PATCH sebelum auth atau query branch lain berjalan', async () => {
  const req = {
    method: 'PATCH',
    url: '/api/transfer',
    query: {},
    headers: {},
  };
  const res = createResponse();

  await handler(req, res);

  assert.equal(res.statusCode, 405);
  assert.deepEqual(res.body, { error: 'Method not allowed.' });
});