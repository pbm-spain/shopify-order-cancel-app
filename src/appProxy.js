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
