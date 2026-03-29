/**
 * Simple CSRF protection using the Synchronizer Token pattern.
 * Generates a per-session CSRF token and validates it on POST requests.
 *
 * Since this app is stateless (no sessions), we use a signed double-submit cookie approach:
 * - On GET /cancel-order, set a random CSRF token as a cookie + inject it into the form.
 * - On POST, compare the cookie value with the form field value.
 */

import crypto from 'crypto';
import { config } from './config.js';

const CSRF_COOKIE = '_csrf_token';
const CSRF_FIELD = '_csrf';

/**
 * Generate a CSRF token, set it as a cookie, and attach it to res.locals.
 */
export function csrfGenerate(req, res, next) {
  const token = crypto.randomBytes(32).toString('hex');
  res.cookie(CSRF_COOKIE, token, {
    httpOnly: true,
    secure: config.appBaseUrl.startsWith('https'),
    sameSite: 'Strict',
    maxAge: 24 * 60 * 60 * 1000, // 24 hours (Fix #10)
  });
  res.locals.csrfToken = token;
  next();
}

/**
 * Validate the CSRF token from the form body against the cookie.
 */
export function csrfValidate(req, res, next) {
  const cookieToken = req.cookies?.[CSRF_COOKIE] || '';
  const bodyToken = req.body?.[CSRF_FIELD] || '';

  if (!cookieToken || !bodyToken) {
    return res.status(403).send('Missing CSRF token. Please reload the form and try again.');
  }

  const cookieBuf = Buffer.from(String(cookieToken));
  const bodyBuf = Buffer.from(String(bodyToken));

  if (cookieBuf.length !== bodyBuf.length || !crypto.timingSafeEqual(cookieBuf, bodyBuf)) {
    return res.status(403).send('Invalid CSRF token. Please reload the form and try again.');
  }

  next();
}
