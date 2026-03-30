/**
 * Admin authentication and CSRF middleware.
 *
 * Protects admin routes with a Bearer token defined in ADMIN_API_TOKEN env var.
 * For the HTML dashboard, uses opaque session tokens (NOT the raw API token)
 * stored server-side to prevent token leakage via cookies.
 *
 * Also manages per-session CSRF tokens for admin forms, consolidating all
 * session state into a single Map to avoid scattered session stores.
 */

import crypto from 'crypto';
import { config } from './config.js';

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

const ADMIN_COOKIE = '_admin_session';
const CSRF_COOKIE = '_admin_session_id';

/**
 * Unified server-side session store.
 * Maps opaque session token → { createdAt: number, ip: string }
 * In production with multiple instances, replace with Redis or DB-backed store.
 */
const sessions = new Map();

/**
 * Admin CSRF session store.
 * Maps session IDs → { csrfToken: string, createdAt: number }
 * Kept as a separate Map from auth sessions because they serve different cookies
 * and have different lifecycles (auth sessions are per-login, CSRF sessions are
 * per-browser-visit including Bearer-auth users who never log in).
 */
const csrfSessions = new Map();

const SESSION_MAX_AGE_MS = 8 * 60 * 60 * 1000; // 8 hours
let sessionCleanupInterval = null;

export function startSessionCleanup() {
  sessionCleanupInterval = setInterval(() => {
    try {
      const now = Date.now();
      for (const [token, session] of sessions) {
        if (now - session.createdAt > SESSION_MAX_AGE_MS) {
          sessions.delete(token);
        }
      }
      for (const [sessionId, { createdAt }] of csrfSessions) {
        if (now - createdAt > SESSION_MAX_AGE_MS) {
          csrfSessions.delete(sessionId);
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
    if (safeCompare(hashToken(token), config.adminApiToken)) {
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
          const csrfToken = generateLoginCsrf(req, res);
          return res.status(401).send(loginPage(req.originalUrl, 'Session IP mismatch. Please log in again.', res.locals.nonce, csrfToken));
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
    const csrfToken = generateLoginCsrf(req, res);
    return res.status(401).send(loginPage(req.originalUrl, '', res.locals.nonce, csrfToken));
  }
  return res.status(401).json({ error: 'Unauthorized' });
}

/**
 * POST /admin/login — validate token and issue opaque session cookie.
 * Fix #1: Validate redirect parameter to prevent open redirects.
 */
export function adminLogin(req, res) {
  // Validate CSRF token on login POST
  const csrfError = validateLoginCsrf(req);
  if (csrfError) {
    const csrfToken = generateLoginCsrf(req, res);
    return res.status(403).send(loginPage(req.body.redirect || '/admin', 'Invalid CSRF token. Please try again.', res.locals.nonce, csrfToken));
  }

  const { token } = req.body;
  if (!token || !safeCompare(hashToken(token), config.adminApiToken)) {
    const csrfToken = generateLoginCsrf(req, res);
    return res.status(401).send(loginPage(req.body.redirect || '/admin', 'Incorrect token.', res.locals.nonce, csrfToken));
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

// ─── Admin CSRF middleware ───────────────────────────────────────────

/**
 * Generate or reuse a CSRF token for the admin session.
 * Reuses existing token for the session instead of regenerating on every page
 * load — prevents stale-token errors with multiple tabs or refresh.
 */
export function adminCsrfGenerate(req, res, next) {
  const sessionId = req.cookies?.[CSRF_COOKIE] || crypto.randomBytes(16).toString('hex');

  let session = csrfSessions.get(sessionId);
  if (!session || !session.csrfToken) {
    const csrfToken = crypto.randomBytes(32).toString('hex');
    session = { csrfToken, createdAt: Date.now() };
    csrfSessions.set(sessionId, session);
  }

  res.cookie(CSRF_COOKIE, sessionId, {
    httpOnly: true,
    sameSite: 'Strict',
    secure: config.appBaseUrl.startsWith('https'),
    maxAge: SESSION_MAX_AGE_MS,
  });

  res.locals.adminCsrfToken = session.csrfToken;
  next();
}

/**
 * Validate a CSRF token from the admin session.
 * Uses timing-safe comparison to prevent timing attacks.
 */
export function adminCsrfValidate(req, res, next) {
  const sessionId = req.cookies?.[CSRF_COOKIE] || '';
  const bodyToken = req.body?._csrf || '';

  if (!sessionId || !bodyToken) {
    return res.redirect('/admin?msg=Invalid CSRF token. Please reload the page.&type=error');
  }

  const session = csrfSessions.get(sessionId);
  if (!session) {
    return res.redirect('/admin?msg=Invalid session. Please reload the page.&type=error');
  }

  const storedBuf = Buffer.from(String(session.csrfToken));
  const bodyBuf = Buffer.from(String(bodyToken));
  if (storedBuf.length !== bodyBuf.length || !crypto.timingSafeEqual(storedBuf, bodyBuf)) {
    return res.redirect('/admin?msg=Invalid CSRF token. Please reload the page.&type=error');
  }

  next();
}

/**
 * Generate a CSRF token for the login form and set the session cookie.
 * Reuses existing session if available.
 */
function generateLoginCsrf(req, res) {
  const sessionId = req.cookies?.[CSRF_COOKIE] || crypto.randomBytes(16).toString('hex');

  let session = csrfSessions.get(sessionId);
  if (!session || !session.csrfToken) {
    const csrfToken = crypto.randomBytes(32).toString('hex');
    session = { csrfToken, createdAt: Date.now() };
    csrfSessions.set(sessionId, session);
  }

  res.cookie(CSRF_COOKIE, sessionId, {
    httpOnly: true,
    sameSite: 'Strict',
    secure: config.appBaseUrl.startsWith('https'),
    maxAge: SESSION_MAX_AGE_MS,
  });

  return session.csrfToken;
}

/**
 * Validate the CSRF token submitted with the login form.
 * Returns an error string if invalid, null if valid.
 */
function validateLoginCsrf(req) {
  const sessionId = req.cookies?.[CSRF_COOKIE] || '';
  const bodyToken = req.body?._csrf || '';

  if (!sessionId || !bodyToken) return 'missing';

  const session = csrfSessions.get(sessionId);
  if (!session) return 'no-session';

  const storedBuf = Buffer.from(String(session.csrfToken));
  const bodyBuf = Buffer.from(String(bodyToken));
  if (storedBuf.length !== bodyBuf.length || !crypto.timingSafeEqual(storedBuf, bodyBuf)) {
    return 'mismatch';
  }

  return null;
}

function loginPage(redirect = '/admin', error = '', nonce = '', csrfToken = '') {
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
    <input type="hidden" name="_csrf" value="${csrfToken}" />
    <input type="password" name="token" placeholder="ADMIN_API_TOKEN" required autofocus />
    <button type="submit">Sign In</button>
    ${safeError}
  </form>
</body>
</html>`;
}
