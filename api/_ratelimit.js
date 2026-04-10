/**
 * Simple in-memory rate limiter for Vercel serverless.
 * Resets when instance cold-starts (acceptable for this scale).
 *
 * Usage:
 *   const { rateLimit } = require('./_ratelimit');
 *   const limiter = rateLimit({ windowMs: 60000, max: 10 });
 *   // inside handler:
 *   if (limiter(req, res)) return; // blocked
 */

function rateLimit({ windowMs = 60000, max = 10 } = {}) {
  const hits = new Map();

  // Cleanup stale entries every 5 minutes
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) {
      if (now - entry.start > windowMs * 2) hits.delete(key);
    }
  }, 5 * 60 * 1000).unref();

  return function check(req, res) {
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
      || req.headers['x-real-ip']
      || req.socket?.remoteAddress
      || 'unknown';
    const now = Date.now();
    let entry = hits.get(ip);

    if (!entry || now - entry.start > windowMs) {
      entry = { start: now, count: 0 };
      hits.set(ip, entry);
    }

    entry.count++;

    if (entry.count > max) {
      const retryAfter = Math.ceil((entry.start + windowMs - now) / 1000);
      res.setHeader('Retry-After', String(retryAfter));
      res.status(429).json({ error: 'Terlalu banyak permintaan. Coba lagi nanti.' });
      return true; // blocked
    }

    return false; // allowed
  };
}

module.exports = { rateLimit };
