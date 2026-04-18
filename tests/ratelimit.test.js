const test = require('node:test');
const assert = require('node:assert/strict');

const { rateLimit } = require('../api/_ratelimit');

function createRequest(url, ipAddress) {
  return {
    url,
    headers: {
      'x-forwarded-for': ipAddress,
    },
    socket: {
      remoteAddress: ipAddress,
    },
  };
}

function createResponse() {
  return {
    headers: {},
    statusCode: 200,
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
  };
}

test('rateLimit memisahkan hit counter untuk bucket berbeda pada route yang sama', async () => {
  const dupeLimiter = rateLimit({ windowMs: 60 * 1000, max: 1, bucket: 'test-input-dupe' });
  const uploadLimiter = rateLimit({ windowMs: 60 * 1000, max: 1, bucket: 'test-input-upload' });
  const request = createRequest('/api/input?dupe=1', '10.10.10.10');

  const firstDupeResponse = createResponse();
  const firstUploadResponse = createResponse();
  const secondDupeResponse = createResponse();
  const secondUploadResponse = createResponse();

  assert.equal(await dupeLimiter(request, firstDupeResponse), false);
  assert.equal(await uploadLimiter(request, firstUploadResponse), false);

  assert.equal(await dupeLimiter(request, secondDupeResponse), true);
  assert.equal(secondDupeResponse.statusCode, 429);
  assert.deepEqual(secondDupeResponse.body, { error: 'Terlalu banyak permintaan. Coba lagi nanti.' });

  assert.equal(await uploadLimiter(request, secondUploadResponse), true);
  assert.equal(secondUploadResponse.statusCode, 429);
  assert.deepEqual(secondUploadResponse.body, { error: 'Terlalu banyak permintaan. Coba lagi nanti.' });
});

test('rateLimit bucket default tetap membatasi route yang sama untuk IP yang sama', async () => {
  const limiter = rateLimit({ windowMs: 60 * 1000, max: 1 });
  const request = createRequest('/api/auth', '10.10.10.11');

  const firstResponse = createResponse();
  const secondResponse = createResponse();

  assert.equal(await limiter(request, firstResponse), false);
  assert.equal(await limiter(request, secondResponse), true);
  assert.equal(secondResponse.statusCode, 429);
});
