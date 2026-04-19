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

async function withEnv(overrides, task) {
  const originalEnv = { ...process.env };

  try {
    for (const [key, value] of Object.entries(overrides || {})) {
      if (value === undefined || value === null) {
        delete process.env[key];
      } else {
        process.env[key] = String(value);
      }
    }

    return await task();
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!Object.prototype.hasOwnProperty.call(originalEnv, key)) {
        delete process.env[key];
      }
    }

    for (const [key, value] of Object.entries(originalEnv)) {
      process.env[key] = value;
    }
  }
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
  assert.equal(firstDupeResponse.headers['X-RateLimit-Store'], 'memory');
  assert.equal(firstUploadResponse.headers['X-RateLimit-Store'], 'memory');

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
  assert.equal(firstResponse.headers['X-RateLimit-Store'], 'memory');
  assert.equal(await limiter(request, secondResponse), true);
  assert.equal(secondResponse.statusCode, 429);
});

test('rateLimit fail-closed di production saat Redis wajib tetapi belum tersedia', async () => {
  await withEnv({
    NODE_ENV: 'production',
    VERCEL_ENV: 'production',
    UPSTASH_REDIS_REST_URL: undefined,
    UPSTASH_REDIS_REST_TOKEN: undefined,
    KV_REST_API_URL: undefined,
    KV_REST_API_TOKEN: undefined,
    RATE_LIMIT_ALLOW_MEMORY_FALLBACK: undefined,
  }, async () => {
    const limiter = rateLimit({ windowMs: 60 * 1000, max: 1, bucket: 'test-prod-redis-required' });
    const request = createRequest('/api/auth', '10.10.10.12');
    const response = createResponse();

    assert.equal(await limiter(request, response), true);
    assert.equal(response.statusCode, 503);
    assert.equal(response.headers['X-RateLimit-Store'], 'redis-required');
    assert.deepEqual(response.body, { error: 'Layanan sementara tidak tersedia. Coba lagi sebentar.' });
  });
});

test('rateLimit tetap bisa fallback ke memory di production jika override emergency aktif', async () => {
  await withEnv({
    NODE_ENV: 'production',
    VERCEL_ENV: 'production',
    UPSTASH_REDIS_REST_URL: undefined,
    UPSTASH_REDIS_REST_TOKEN: undefined,
    KV_REST_API_URL: undefined,
    KV_REST_API_TOKEN: undefined,
    RATE_LIMIT_ALLOW_MEMORY_FALLBACK: '1',
  }, async () => {
    const limiter = rateLimit({ windowMs: 60 * 1000, max: 1, bucket: 'test-prod-memory-override' });
    const request = createRequest('/api/auth', '10.10.10.13');

    const firstResponse = createResponse();
    const secondResponse = createResponse();

    assert.equal(await limiter(request, firstResponse), false);
    assert.equal(firstResponse.headers['X-RateLimit-Store'], 'memory');
    assert.equal(await limiter(request, secondResponse), true);
    assert.equal(secondResponse.statusCode, 429);
  });
});

test('rateLimit menormalkan env Redis yang terkutip dan ber-whitespace', async () => {
  const originalFetch = global.fetch;
  const calls = [];

  global.fetch = async (url, options = {}) => {
    calls.push({ url, authorization: options.headers && options.headers.Authorization });
    if (String(url).includes('/INCR/')) {
      return {
        ok: true,
        json: async () => ({ result: 1 }),
      };
    }

    if (String(url).includes('/PEXPIRE/')) {
      return {
        ok: true,
        json: async () => ({ result: 1 }),
      };
    }

    throw new Error('Unexpected Redis command: ' + url);
  };

  try {
    await withEnv({
      NODE_ENV: 'production',
      VERCEL_ENV: 'production',
      UPSTASH_REDIS_REST_URL: '  "https://redis.example.test/"  ',
      UPSTASH_REDIS_REST_TOKEN: "  'token-123'  ",
      RATE_LIMIT_ALLOW_MEMORY_FALLBACK: undefined,
    }, async () => {
      const limiter = rateLimit({ windowMs: 60 * 1000, max: 2, bucket: 'test-quoted-redis-env' });
      const request = createRequest('/api/input', '10.10.10.14');
      const response = createResponse();

      assert.equal(await limiter(request, response), false);
      assert.equal(response.headers['X-RateLimit-Store'], 'redis');
    });
  } finally {
    global.fetch = originalFetch;
  }

  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /^https:\/\/redis\.example\.test\/INCR\//);
  assert.equal(calls[0].authorization, 'Bearer token-123');
  assert.match(calls[1].url, /^https:\/\/redis\.example\.test\/PEXPIRE\//);
});
