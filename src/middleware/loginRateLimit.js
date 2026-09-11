/**
 * In-memory login rate limiter (per client IP).
 * Suitable for a single-admin platform; resets on process restart.
 */
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;
const CLEANUP_EVERY = 100;

/** @type {Map<string, { count: number, resetAt: number }>} */
const attempts = new Map();
let hitCount = 0;

function clientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.ip || req.socket?.remoteAddress || 'unknown';
}

function pruneExpired(now) {
  for (const [key, entry] of attempts) {
    if (now >= entry.resetAt) attempts.delete(key);
  }
}

function loginRateLimit(req, res, next) {
  const now = Date.now();
  hitCount += 1;
  if (hitCount % CLEANUP_EVERY === 0) pruneExpired(now);

  const key = `login:${clientIp(req)}`;
  let entry = attempts.get(key);
  if (!entry || now >= entry.resetAt) {
    entry = { count: 0, resetAt: now + WINDOW_MS };
    attempts.set(key, entry);
  }

  entry.count += 1;
  if (entry.count > MAX_ATTEMPTS) {
    const retryAfter = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
    res.set('Retry-After', String(retryAfter));
    return res.status(429).json({
      ok: false,
      error: 'Too many login attempts. Try again later.',
      retryAfterSec: retryAfter,
    });
  }

  return next();
}

module.exports = { loginRateLimit };
