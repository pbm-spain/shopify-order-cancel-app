import crypto from 'crypto';

export function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

export function normalizeOrderNumber(orderInput) {
  const raw = String(orderInput || '').trim();
  if (!raw) return '';
  return raw.startsWith('#') ? raw : `#${raw}`;
}

export function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

export function createToken() {
  return crypto.randomBytes(32).toString('hex');
}

export function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function minutesFromNow(minutes) {
  return new Date(Date.now() + minutes * 60 * 1000).toISOString();
}

/**
 * Validate that a normalized order number looks reasonable (# + digits).
 * Fix #16: Allow up to 19 digits for Shopify 64-bit IDs.
 */
export function isValidOrderNumber(orderNumber) {
  // Reject leading zeros to prevent enumeration via #1, #01, #001, etc.
  // Allow up to 19 digits for Shopify 64-bit IDs
  return /^#[1-9]\d{0,18}$/.test(orderNumber);
}

export function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
