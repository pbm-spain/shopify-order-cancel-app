import crypto from 'crypto';
import { config } from './config.js';

/**
 * Verify Shopify App Proxy signature.
 *
 * Algorithm (per Shopify docs, March 2026):
 * 1. Remove the `signature` parameter
 * 2. Format remaining params as `key=value` strings (arrays joined with comma)
 * 3. Sort the formatted strings alphabetically
 * 4. Join them together (no separator)
 * 5. HMAC-SHA256 with shared secret, hex digest
 * 6. Compare with timing-safe equality
 *
 * @see https://shopify.dev/docs/apps/build/online-store/app-proxies/authenticate-app-proxies
 */
function buildMessage(params) {
  return Object.entries(params)
    .filter(([key]) => key !== 'signature')
    .map(([key, value]) => {
      // Array values are joined with comma per Shopify docs
      const v = Array.isArray(value) ? value.join(',') : value;
      return `${key}=${v}`;
    })
    .sort()
    .join('');
}

export function verifyAppProxySignature(query) {
  const provided = query.signature;
  if (!provided) return false;

  const message = buildMessage(query);
  const calculated = crypto
    .createHmac('sha256', config.appProxySecret)
    .update(message)
    .digest('hex');

  // Timing-safe comparison to prevent timing attacks
  const providedBuf = Buffer.from(String(provided));
  const calculatedBuf = Buffer.from(calculated);
  if (providedBuf.length !== calculatedBuf.length) return false;
  return crypto.timingSafeEqual(providedBuf, calculatedBuf);
}

/**
 * Verify App Proxy timestamp is within acceptable age to prevent replay attacks.
 *
 * Shopify includes a timestamp query parameter in App Proxy requests.
 * This function validates that the timestamp is recent (within maxAgeSeconds).
 * Allows up to 30 seconds in the future (clock skew tolerance) to handle client/server time drift.
 *
 * @param {Object} query - Query parameters from the request
 * @param {number} maxAgeSeconds - Maximum age of the timestamp in seconds (default 300 = 5 minutes)
 * @returns {boolean} true if timestamp is valid and recent, false otherwise
 */
export function verifyTimestamp(query, maxAgeSeconds = 300) {
  const timestamp = query.timestamp;
  if (!timestamp) return false;

  const parsed = parseInt(String(timestamp), 10);
  if (isNaN(parsed)) return false;

  const requestTime = new Date(parsed * 1000); // Shopify sends Unix timestamp in seconds
  // Fix #10: Explicitly check for Invalid Date
  if (isNaN(requestTime.getTime())) return false;

  const now = Date.now();
  const maxAgeMs = maxAgeSeconds * 1000;
  const clockSkewMs = 30 * 1000; // Allow 30 seconds of clock skew (future tolerance)

  // Allow timestamps that are:
  // - Not older than maxAgeSeconds (5 minutes)
  // - Not more than 30 seconds in the future (clock skew tolerance)
  const ageMs = now - requestTime.getTime();
  return ageMs >= -clockSkewMs && ageMs <= maxAgeMs;
}
