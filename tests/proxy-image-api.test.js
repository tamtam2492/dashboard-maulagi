const test = require('node:test');
const assert = require('node:assert/strict');

const handler = require('../api/proxy-image');

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
    send(payload) {
      this.body = payload;
      return this;
    },
    end() {
      return this;
    },
  };
}

test('proxy-image menolak method selain GET', async () => {
  const req = {
    method: 'POST',
    url: '/api/proxy-image?id=abc1234567',
    query: { id: 'abc1234567' },
    headers: {},
  };
  const res = createResponse();

  await handler(req, res);

  assert.equal(res.statusCode, 405);
  assert.deepEqual(res.body, { error: 'Method not allowed.' });
});