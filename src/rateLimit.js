/**
 * Simple in-memory sliding window rate limiter.
 * No external dependencies needed.
 *
 * For production with multiple instances, replace with Redis-backed limiter.
 *
 * Fix #24: Each rate limiter instance gets its own Map to prevent
 * shorter-window cleanups from corrupting longer-window limiters.
 */

/**
 * Create a rate limiting middleware.
 * @param {object} opts
 * @param {number} opts.windowMs  - Time window in milliseconds (default: 60000 = 1 min)
 * @param {number} opts.maxHits   - Max requests per window (default: 10)
 * @param {function} opts.keyFn   - Function(req) returning the rate-limit key (default: IP)
 * @param {string} opts.message   - Error message on limit exceeded
 */
export function rateLimit({
  windowMs = 60_000,
  maxHits = 10,
  keyFn = (req) => req.ip || req.socket.remoteAddress || 'unknown',
  message = 'Too many requests. Please try again later.',
} = {}) {
  // Fix #24: Each instance gets its own isolated Map
  const windows = new Map();

  // Cleanup old entries every 5 minutes (only touches this instance's Map)
  setInterval(() => {
    try {
      const now = Date.now();
      for (const [key, timestamps] of windows) {
        const filtered = timestamps.filter((t) => now - t < windowMs);
        if (filtered.length === 0) {
          windows.delete(key);
        } else {
          windows.set(key, filtered);
        }
      }
    } catch { /* cleanup failure is non-fatal */ }
  }, 5 * 60_000).unref();

  return (req, res, next) => {
    const key = keyFn(req);
    const now = Date.now();
    const timestamps = (windows.get(key) || []).filter((t) => now - t < windowMs);

    if (timestamps.length >= maxHits) {
      res.set('Retry-After', String(Math.ceil(windowMs / 1000)));
      return res.status(429).send(message);
    }

    timestamps.push(now);
    windows.set(key, timestamps);
    next();
  };
}
