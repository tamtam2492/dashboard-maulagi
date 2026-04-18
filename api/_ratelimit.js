/**
 * Rate limiter for Vercel serverless.
 * Default store is in-memory, with optional Redis REST backend for multi-instance deployments.
 *
 * Usage:
 *   const { rateLimit } = require('./_ratelimit');
 *   const limiter = rateLimit({ windowMs: 60000, max: 10 });
 *   // inside handler:
 *   if (await limiter(req, res)) return; // blocked
 */

const memoryHits = new Map();
let cleanupTimer = null;

function ensureCleanupTimer() {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of memoryHits) {
      if (now - entry.start > entry.windowMs * 2) {
        memoryHits.delete(key);
      }
    }
  }, 5 * 60 * 1000);
  cleanupTimer.unref();
}

function getClientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || req.headers['x-real-ip']
    || req.socket?.remoteAddress
    || 'unknown';
}

function getLimiterScope(req) {
  return String(req.url || req.path || 'unknown').split('?')[0] || 'unknown';
}

function getLimiterBucket(bucket) {
  return String(bucket || 'default')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9:_-]+/g, '-') || 'default';
}

function getRedisConfig() {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  return { url: url.replace(/\/$/, ''), token };
}

async function redisCommand(config, parts) {
  const endpoint = `${config.url}/${parts.map(part => encodeURIComponent(String(part))).join('/')}`;
  const response = await fetch(endpoint, {
    headers: {
      Authorization: `Bearer ${config.token}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Redis rate limit request failed with status ${response.status}`);
  }

  return response.json();
}

function coerceNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function checkMemoryLimit(key, windowMs, max) {
  const now = Date.now();
  let entry = memoryHits.get(key);

  if (!entry || now - entry.start > windowMs) {
    entry = { start: now, count: 0, windowMs };
    memoryHits.set(key, entry);
  }

  entry.count += 1;

  if (entry.count > max) {
    const retryAfter = Math.ceil((entry.start + windowMs - now) / 1000);
    return { blocked: true, retryAfter, remaining: 0 };
  }

  return { blocked: false, retryAfter: 0, remaining: Math.max(0, max - entry.count) };
}

async function checkRedisLimit(config, key, windowMs, max) {
  const incrResponse = await redisCommand(config, ['INCR', key]);
  const count = coerceNumber(incrResponse.result);

  if (count === 1) {
    await redisCommand(config, ['PEXPIRE', key, String(windowMs)]);
  }

  if (count > max) {
    const ttlResponse = await redisCommand(config, ['PTTL', key]);
    const retryAfter = Math.max(1, Math.ceil(coerceNumber(ttlResponse.result, windowMs) / 1000));
    return { blocked: true, retryAfter, remaining: 0 };
  }

  return { blocked: false, retryAfter: 0, remaining: Math.max(0, max - count) };
}

function applyRateLimitHeaders(res, max, result) {
  res.setHeader('X-RateLimit-Limit', String(max));
  res.setHeader('X-RateLimit-Remaining', String(Math.max(0, result.remaining || 0)));
  if (result.retryAfter > 0) {
    res.setHeader('Retry-After', String(result.retryAfter));
  }
}

function rateLimit({ windowMs = 60000, max = 10, bucket = 'default' } = {}) {
  ensureCleanupTimer();
  const limiterBucket = getLimiterBucket(bucket);

  return async function check(req, res) {
    const limiterKey = `ratelimit:${limiterBucket}:${getLimiterScope(req)}:${getClientIp(req)}`;
    const redisConfig = getRedisConfig();

    let result;
    if (redisConfig) {
      try {
        result = await checkRedisLimit(redisConfig, limiterKey, windowMs, max);
      } catch (_) {
        result = checkMemoryLimit(limiterKey, windowMs, max);
      }
    } else {
      result = checkMemoryLimit(limiterKey, windowMs, max);
    }

    applyRateLimitHeaders(res, max, result);

    if (result.blocked) {
      res.status(429).json({ error: 'Terlalu banyak permintaan. Coba lagi nanti.' });
      return true;
    }

    return false;
  };
}

module.exports = { rateLimit };
