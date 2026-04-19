/**
 * Rate limiter for Vercel serverless.
 * Local/test may use in-memory storage, while production expects Redis REST unless
 * RATE_LIMIT_ALLOW_MEMORY_FALLBACK=1 is explicitly enabled for temporary emergency use.
 *
 * Usage:
 *   const { rateLimit } = require('./_ratelimit');
 *   const limiter = rateLimit({ windowMs: 60000, max: 10 });
 *   // inside handler:
 *   if (await limiter(req, res)) return; // blocked
 */

const memoryHits = new Map();
const runtimeAlerts = new Set();
let cleanupTimer = null;

function normalizeText(value, maxLength = 200) {
  return String(value || '').trim().slice(0, maxLength);
}

function isTruthyFlag(value) {
  return ['1', 'true', 'yes', 'on'].includes(normalizeText(value, 20).toLowerCase());
}

function isProductionEnvironment(env = process.env) {
  const nodeEnv = normalizeText(env.NODE_ENV, 40).toLowerCase();
  const vercelEnv = normalizeText(env.VERCEL_ENV, 40).toLowerCase();
  return nodeEnv === 'production' || vercelEnv === 'production';
}

function isMemoryFallbackAllowed(env = process.env) {
  if (isTruthyFlag(env.RATE_LIMIT_ALLOW_MEMORY_FALLBACK)) return true;
  return !isProductionEnvironment(env);
}

function logRateLimitAlertOnce(level, code, message, meta = {}) {
  const alertKey = `${level}:${code}`;
  if (runtimeAlerts.has(alertKey)) return;
  runtimeAlerts.add(alertKey);

  const detailText = Object.entries(meta)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key}=${normalizeText(value, 200)}`)
    .join(' ');
  const line = `[rate-limit] ${message}${detailText ? ` ${detailText}` : ''}`;

  if (level === 'error') {
    console.error(line);
    return;
  }

  console.warn(line);
}

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

function normalizeRedisConfigValue(value) {
  const trimmed = String(value || '').trim();
  const quotedMatch = trimmed.match(/^(["'])(.*)\1$/);
  return quotedMatch ? quotedMatch[2].trim() : trimmed;
}

function getRedisConfig() {
  const url = normalizeRedisConfigValue(process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL);
  const token = normalizeRedisConfigValue(process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN);
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

function applyRateLimitHeaders(res, max, result, store) {
  res.setHeader('X-RateLimit-Limit', String(max));
  res.setHeader('X-RateLimit-Remaining', String(Math.max(0, result.remaining || 0)));
  res.setHeader('X-RateLimit-Store', String(store || 'memory'));
  if (result.retryAfter > 0) {
    res.setHeader('Retry-After', String(result.retryAfter));
  }
}

function blockUnavailableRateLimit(res, max, store) {
  applyRateLimitHeaders(res, max, { remaining: 0, retryAfter: 0 }, store);
  res.status(503).json({ error: 'Layanan sementara tidak tersedia. Coba lagi sebentar.' });
  return true;
}

function rateLimit({ windowMs = 60000, max = 10, bucket = 'default' } = {}) {
  ensureCleanupTimer();
  const limiterBucket = getLimiterBucket(bucket);

  return async function check(req, res) {
    const limiterKey = `ratelimit:${limiterBucket}:${getLimiterScope(req)}:${getClientIp(req)}`;
    const redisConfig = getRedisConfig();
    const productionEnvironment = isProductionEnvironment();
    const memoryFallbackAllowed = isMemoryFallbackAllowed();

    let result;
    let store = 'memory';
    if (redisConfig) {
      try {
        result = await checkRedisLimit(redisConfig, limiterKey, windowMs, max);
        store = 'redis';
      } catch (err) {
        const errorMessage = normalizeText(err && err.message, 200) || 'unknown';
        if (!memoryFallbackAllowed) {
          logRateLimitAlertOnce('error', 'redis-unavailable', 'Redis rate limit gagal di production; request ditolak sampai store pulih.', {
            bucket: limiterBucket,
            scope: getLimiterScope(req),
            error: errorMessage,
          });
          return blockUnavailableRateLimit(res, max, 'redis-unavailable');
        }

        result = checkMemoryLimit(limiterKey, windowMs, max);
        store = 'memory-fallback';
        logRateLimitAlertOnce('warn', productionEnvironment ? 'redis-memory-fallback-production' : 'redis-memory-fallback', productionEnvironment
          ? 'Redis rate limit gagal di production; override emergency mengaktifkan fallback in-memory.'
          : 'Redis rate limit gagal; fallback ke in-memory limiter.', {
          bucket: limiterBucket,
          scope: getLimiterScope(req),
          error: errorMessage,
        });
      }
    } else {
      if (!memoryFallbackAllowed) {
        logRateLimitAlertOnce('error', 'redis-required-missing', 'Redis rate limit wajib aktif di production; request ditolak sampai env Upstash tersedia atau override emergency diaktifkan.', {
          bucket: limiterBucket,
          scope: getLimiterScope(req),
        });
        return blockUnavailableRateLimit(res, max, 'redis-required');
      }

      result = checkMemoryLimit(limiterKey, windowMs, max);
      if (productionEnvironment) {
        logRateLimitAlertOnce('warn', 'memory-fallback-override', 'Production memakai fallback in-memory untuk rate limit karena override emergency aktif.', {
          bucket: limiterBucket,
          scope: getLimiterScope(req),
        });
      }
    }

    applyRateLimitHeaders(res, max, result, store);

    if (result.blocked) {
      res.status(429).json({ error: 'Terlalu banyak permintaan. Coba lagi nanti.' });
      return true;
    }

    return false;
  };
}

module.exports = { rateLimit };
