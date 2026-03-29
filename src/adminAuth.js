/**
 * Admin authentication middleware.
 *
 * Protects admin routes with a Bearer token defined in ADMIN_API_TOKEN env var.
 * For the HTML dashboard, uses opaque session tokens (NOT the raw API token)
 * stored server-side to prevent token leakage via cookies.
 */

import crypto from 'crypto';
import { config } from './config.js';

const ADMIN_COOKIE = '_admin_session';

/**
 * Server-side session store.
 * Maps opaque session token → { createdAt: number }
 * In production with multiple instances, replace with Redis or DB-backed store.
 */
const sessions = new Map();

// Auto-cleanup expired sessions every 30 minutes
const SESSION_MAX_AGE_MS = 8 * 60 * 60 * 1000; // 8 hours
let sessionCleanupInterval = null;

export function startSessionCleanup() {
  // Fix #29: Add .unref() to prevent keeping the process alive during shutdown
  sessionCleanupInterval = setInterval(() => {
    try {
      const now = Date.now();
      for (const [token, session] of sessions) {
        if (now - session.createdAt > SESSION_MAX_AGE_MS) {
          sessions.delete(token);
        }
      }
    } catch { /* cleanup failure is non-fatal */ }
  }, 30 * 60 * 1000);
  sessionCleanupInterval.unref();
}

export function stopSessionCleanup() {
  if (sessionCleanupInterval) {
    clearInterval(sessionCleanupInterval);
    sessionCleanupInterval = null;
  }
}

/**
 * Middleware: require valid admin auth (bearer token OR session cookie).
 * Fix #7: Add IP binding to session for additional session fixation protection.
 */
export function requireAdmin(req, res, next) {
  // Check Bearer token in Authorization header (for API calls)
  const authHeader = req.headers.authorization || '';
  if (authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    if (safeCompare(token, config.adminApiToken)) {
      return next();
    }
  }

  // Check session cookie (opaque token mapped server-side)
  const sessionToken = req.cookies?.[ADMIN_COOKIE];
  if (sessionToken && sessions.has(sessionToken)) {
    const session = sessions.get(sessionToken);
    // Verify session hasn't expired
    if (Date.now() - session.createdAt < SESSION_MAX_AGE_MS) {
      // Verify IP binding (Fix #7: session fixation protection)
      const clientIp = req.ip || req.socket.remoteAddress;
      if (session.ip && session.ip !== clientIp) {
        sessions.delete(sessionToken);
        if (req.accepts('html')) {
          return res.status(401).send(loginPage(req.originalUrl, 'Session IP mismatch. Please log in again.', res.locals.nonce));
        }
        return res.status(401).json({ error: 'Unauthorized' });
      }
      return next();
    }
    // Expired — clean up
    sessions.delete(sessionToken);
  }

  // Not authenticated — show login page or return 401
  if (req.accepts('html')) {
    return res.status(401).send(loginPage(req.originalUrl, '', res.locals.nonce));
  }
  return res.status(401).json({ error: 'Unauthorized' });
}

/**
 * POST /admin/login — validate token and issue opaque session cookie.
 * Fix #1: Validate redirect parameter to prevent open redirects.
 */
export function adminLogin(req, res) {
  const { token } = req.body;
  if (!token || !safeCompare(token, config.adminApiToken)) {
    return res.status(401).send(loginPage(req.body.redirect || '/admin', 'Incorrect token.', res.locals.nonce));
  }

  // Generate opaque session token (NOT the API token)
  const sessionToken = crypto.randomBytes(32).toString('hex');
  // Store IP for session binding (Fix #7)
  const clientIp = req.ip || req.socket.remoteAddress;
  sessions.set(sessionToken, { createdAt: Date.now(), ip: clientIp });

  res.cookie(ADMIN_COOKIE, sessionToken, {
    httpOnly: true,
    secure: config.appBaseUrl.startsWith('https'),
    sameSite: 'Strict',
    maxAge: SESSION_MAX_AGE_MS,
  });

  // Whitelist allowed redirect paths (Fix #1: open redirect protection)
  const redirect = req.body.redirect || '/admin';
  const safeRedirect = redirect && String(redirect).startsWith('/admin')
    ? redirect
    : '/admin';

  return res.redirect(safeRedirect);
}

/**
 * GET /admin/logout — invalidate session server-side and clear cookie.
 */
export function adminLogout(req, res) {
  const sessionToken = req.cookies?.[ADMIN_COOKIE];
  if (sessionToken) {
    sessions.delete(sessionToken);
  }
  res.clearCookie(ADMIN_COOKIE);
  res.redirect('/admin');
}

function safeCompare(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function loginPage(redirect = '/admin', error = '', nonce = '') {
  const safeRedirect = String(redirect).replace(/"/g, '&quot;');
  const safeError = error ? `<p class="error">${String(error).replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>` : '';
  const nonceAttr = nonce ? ` nonce="${nonce}"` : '';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Admin Login</title>
  <style${nonceAttr}>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 400px; margin: 80px auto; padding: 0 16px; color: #111; }
    h1 { font-size: 24px; margin-bottom: 8px; }
    input { width: 100%; padding: 12px; border: 1px solid #ccc; border-radius: 8px; box-sizing: border-box; margin-top: 8px; }
    button { margin-top: 12px; width: 100%; background: #111; color: white; border: 0; padding: 14px; border-radius: 8px; cursor: pointer; font-size: 15px; }
    button:hover { background: #333; }
    .error { color: #c0392b; font-size: 14px; margin-top: 8px; }
  </style>
</head>
<body>
  <h1>Admin</h1>
  <p>Enter your admin token to access the dashboard.</p>
  <form method="post" action="/admin/login">
    <input type="hidden" name="redirect" value="${safeRedirect}" />
    <input type="password" name="token" placeholder="ADMIN_API_TOKEN" required autofocus />
    <button type="submit">Sign In</button>
    ${safeError}
  </form>
</body>
</html>`;
}
