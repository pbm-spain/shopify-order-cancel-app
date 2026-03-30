import express from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import cookieParser from 'cookie-parser';
import { fileURLToPath } from 'url';
import { config } from './config.js';
import { verifyAppProxySignature, verifyTimestamp } from './appProxy.js';
import {
  cancelOrder, createOrderRefund, findOrderByEmailAndName, findOrderById, isOrderCancelable,
  addTagsToOrder, removeTagsFromOrder, updateOrderNote,
  ALL_FULFILLMENT_STATUSES, ALL_FINANCIAL_STATUSES,
} from './shopify.js';
import { createToken, hashToken, minutesFromNow, normalizeEmail, normalizeOrderNumber, isValidOrderNumber, escapeHtml } from './utils.js';
import {
  saveRequest, findRequestByTokenHash, updateRequest, markTokenAsUsed,
  findPendingRequestForOrder, findRequestById,
  updateRefundById, atomicUpdateRefundById, isAutoRefundEnabled,
  getAllowedFulfillmentStatuses, getAllowedFinancialStatuses,
  setSetting, getPendingRefundsPaginated, getRecentCancellationsPaginated,
  markEmailSent, getDb, getFailedWebhooks, getFailedWebhookById, findStaleCancellations,
} from './storage.js';
import { sendConfirmationEmail } from './email.js';
import { rateLimit } from './rateLimit.js';
import { csrfGenerate, csrfValidate, CSRF_COOKIE, CSRF_FIELD } from './csrf.js';
import { requireAdmin, adminLogin, adminLogout, adminCsrfGenerate, adminCsrfValidate } from './adminAuth.js';
import { buildStatusCheckboxes, buildPendingTable, buildRecentTable, buildPagination } from './views.js';
import { logger, auditLog } from './logger.js';
import { verifyWebhookSignature, handleOrderUpdated, handleOrderCancelled, handleRefundCreated } from './webhooks.js';
import { expressErrorHandler } from './errorHandler.js';
import morgan from 'morgan';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
// Fix #43: Make trust proxy configurable. Default to disabled (safest).
// Set TRUST_PROXY=1 when behind exactly one reverse proxy (Nginx, Cloudflare, etc.).
// Without a trusted proxy, leaving this enabled allows X-Forwarded-For spoofing
// which bypasses all IP-based rate limiting (login, cancel, confirm endpoints).
app.set('trust proxy', config.trustProxy);

// Log HTTPS warning if app URL is not HTTPS (Fix #14)
if (!config.appBaseUrl.startsWith('https')) {
  logger.warn('HTTPS not configured. appBaseUrl should start with https for security.');
}

// ─── Request correlation ID (Fix #12) ──────────────────────────────

app.use((req, res, next) => {
  req.traceId = crypto.randomUUID();
  next();
});

// ─── Security headers with CSP nonces (Fix #17) ────────────────────
// Fix #1: Skip X-Frame-Options and CSP for proxy routes so Shopify can embed
// the response in the theme. Shopify App Proxy requires framing to work.
// Support dynamic CSP for embedded admin: when ?shop= or ?embedded=1 is present,
// allow framing from Shopify Admin by setting appropriate frame-ancestors.

app.use((_req, res, next) => {
  const nonce = crypto.randomBytes(16).toString('hex');
  res.locals.nonce = nonce;

  // Check if this is a proxy route (GET /proxy or POST /proxy/*)
  const isProxyRoute = _req.path === '/proxy' || _req.path.startsWith('/proxy/');

  // Check if this is an embedded admin request (indicated by ?shop= or ?embedded=1 query param)
  const isEmbeddedAdmin = _req.path === '/admin' && (_req.query.shop || _req.query.embedded === '1');

  res.setHeader('X-Content-Type-Options', 'nosniff');

  // Handle X-Frame-Options
  if (!isProxyRoute) {
    if (isEmbeddedAdmin) {
      // Allow framing when embedded in Shopify Admin
      // Don't set X-Frame-Options — the CSP frame-ancestors will handle it
    } else {
      // Prevent framing for non-embedded routes
      res.setHeader('X-Frame-Options', 'DENY');
    }
  }

  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  // Handle CSP
  if (!isProxyRoute) {
    let csp;
    if (isEmbeddedAdmin) {
      // For embedded admin, allow framing from the shop domain and Shopify Admin
      // SECURITY FIX #52: Validate shop domain against configured domain to prevent CSP injection
      const shopDomain = String(_req.query.shop || config.shopDomain);
      if (_req.query.shop && shopDomain !== config.shopDomain) {
        // Reject invalid shop domain (prevents CSP breakout attacks)
        logger.warn('Invalid shop domain in embedded admin request', {
          requestedShop: shopDomain,
          configuredShop: config.shopDomain,
          ip: _req.ip,
        });
        // Use the configured shop domain instead of the untrusted parameter
        // This ensures the CSP only allows framing from the correct shop
      }
      const trustedShopDomain = config.shopDomain;
      csp = `default-src 'self'; script-src 'self' 'nonce-${nonce}' https://cdn.shopify.com; style-src 'self' 'nonce-${nonce}' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; frame-ancestors https://${trustedShopDomain} https://admin.shopify.com;`;
    } else {
      // For standalone admin, disallow framing
      csp = `default-src 'self'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'nonce-${nonce}' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; frame-ancestors 'none';`;
    }
    res.setHeader('Content-Security-Policy', csp);
  }

  if (config.appBaseUrl.startsWith('https')) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

// Capture raw body for webhook HMAC verification (Fix #20: use verify callback
// instead of stream listeners, which would consume the stream before body parsers)
function captureRawBody(req, _res, buf) {
  req.rawBody = buf.toString('utf8');
}

app.use(express.urlencoded({ extended: false, limit: '10kb', verify: captureRawBody }));
app.use(express.json({ limit: '10kb', verify: captureRawBody }));

// Content-Type validation middleware (Fix #18)
app.use((req, res, next) => {
  if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
    const contentType = req.get('content-type') || '';
    if (!contentType.includes('application/json') && !contentType.includes('application/x-www-form-urlencoded')) {
      return res.status(415).send('Unsupported Media Type. Only JSON and form-encoded data are accepted.');
    }
  }
  next();
});

// HTTP request logging — use custom token to redact sensitive query params
morgan.token('safe-url', (req) => {
  const url = req.originalUrl || req.url;
  try {
    const parsed = new URL(url, 'http://localhost');
    for (const key of ['token', 'signature', 'hmac']) {
      if (parsed.searchParams.has(key)) {
        parsed.searchParams.set(key, '[REDACTED]');
      }
    }
    return parsed.pathname + parsed.search;
  } catch {
    return url;
  }
});

if (process.env.NODE_ENV !== 'test') {
  app.use(morgan(':remote-addr :method :safe-url :status :res[content-length] - :response-time ms'));
}
app.use(cookieParser());
app.use(express.static(path.join(__dirname, '..', 'public')));

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Rate limit on cancellation request endpoint (by IP)
const cancelRateLimit = rateLimit({
  windowMs: config.rateLimitWindowMs,
  maxHits: config.rateLimitMaxRequests,
  message: 'Too many cancellation requests. Please try again later.',
});

// Rate limit per email address (Fix #10: consistent behavior regardless of email validity)
// Uses IP as fallback key when email is missing/invalid to prevent DoS via empty-key collisions
const emailRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  maxHits: 3,
  keyFn: (req) => {
    const email = normalizeEmail(req.body?.email || '');
    return email && EMAIL_REGEX.test(email) ? `email:${email}` : `ip:${req.ip}`;
  },
  message: 'Too many requests. Please try again later.',
});

// Rate limit on /confirm endpoint to prevent token brute-forcing (Fix #12, Fix #10)
// Use IP as PRIMARY key (30 attempts per IP per hour) to prevent per-token bypass
const confirmRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  maxHits: 30,
  keyFn: (req) => {
    // Use IP as primary key to prevent bypassing rate limit via token enumeration
    return `confirm:${req.ip}`;
  },
  message: 'Too many confirmation attempts. Please try again later.',
});

// Rate limit on /admin/login to prevent brute-force (Fix #9)
const adminLoginRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  maxHits: 5,
  keyFn: (req) => req.ip,
  message: 'Too many login attempts. Please try again in 15 minutes.',
});

// Rate limit on /admin/api/settings (Fix #19)
const adminSettingsRateLimit = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  maxHits: 20,
  keyFn: (req) => req.ip,
  message: 'Too many setting changes. Please try again later.',
});

// ─── Health (Fix #7: test DB connectivity) ──────────────────────────

app.get('/health', (_req, res) => {
  try {
    const db = getDb();
    // Execute a simple query to verify database connectivity
    db.prepare('SELECT 1').get();
    res.json({ ok: true, version: '0.12.0' });
  } catch (error) {
    logger.error('Health check failed', { error: error.message });
    res.status(503).json({ ok: false, error: 'Database unavailable' });
  }
});

// ─── Form (with CSRF token) ──────────────────────────────────────────

app.get('/cancel-order', csrfGenerate, (_req, res) => {
  const template = fs.readFileSync(path.join(__dirname, '..', 'views', 'form.html'), 'utf8');
  const html = template
    .replace(/\{\{CSRF_TOKEN\}\}/g, res.locals.csrfToken)
    .replace(/\{\{NONCE\}\}/g, res.locals.nonce);
  res.type('html').send(html);
});

// ─── Proxy Form (served through Shopify App Proxy) ─────────────────────
// Returns application/liquid so Shopify wraps the form in the theme
// Verifies App Proxy signature and timestamp to prevent replay attacks

app.get('/proxy', (_req, res) => {
  try {
    // Verify App Proxy HMAC signature
    const signatureOk = verifyAppProxySignature(_req.query);
    if (!signatureOk) {
      logger.warn('Invalid app proxy signature on GET /proxy', { ip: _req.ip });
      return res.status(401).send('Invalid App Proxy signature.');
    }

    // Verify timestamp to prevent replay attacks (5-minute window)
    if (!verifyTimestamp(_req.query)) {
      logger.warn('Invalid or expired timestamp on GET /proxy', { ip: _req.ip, timestamp: _req.query.timestamp });
      return res.status(401).send('Request timestamp is invalid or expired.');
    }

    const template = fs.readFileSync(path.join(__dirname, '..', 'views', 'proxy-form.html'), 'utf8');
    const html = template
      .replace(/\{\{CSRF_TOKEN\}\}/g, '')
      .replace(/\{\{NONCE\}\}/g, res.locals.nonce);

    res.type('application/liquid').send(html);
  } catch (error) {
    logger.error('Proxy form request failed', { error: error.message, stack: error.stack });
    return res.status(500).send('Could not load the cancellation form.');
  }
});

// ─── Cancellation Request (App Proxy POST or Standalone) ──────────────
// Supports two auth flows:
// 1. Via Shopify App Proxy: requires signature + timestamp verification (no CSRF)
// 2. Standalone form: requires CSRF token validation (no signature)

function verifyRequestAuth(req, res) {
  const hasAppProxySignature = Boolean(req.query.signature);

  if (hasAppProxySignature) {
    // App Proxy flow: verify signature and timestamp
    const signatureOk = verifyAppProxySignature(req.query);
    if (!signatureOk) {
      logger.warn('Invalid app proxy signature on POST /proxy/request', { ip: req.ip });
      return { ok: false, status: 401, message: 'Invalid App Proxy signature.' };
    }

    if (!verifyTimestamp(req.query)) {
      logger.warn('Invalid or expired timestamp on POST /proxy/request', { ip: req.ip, timestamp: req.query.timestamp });
      return { ok: false, status: 401, message: 'Request timestamp is invalid or expired.' };
    }

    return { ok: true };
  }

  // Standalone flow: use CSRF token validation
  const cookieToken = req.cookies?.[CSRF_COOKIE] || '';
  const bodyToken = req.body?.[CSRF_FIELD] || '';

  if (!cookieToken || !bodyToken) {
    logger.warn('Missing CSRF token on POST /proxy/request', { ip: req.ip, hasCookie: Boolean(cookieToken), hasBody: Boolean(bodyToken) });
    return { ok: false, status: 403, message: 'Missing CSRF token. Please reload the form and try again.' };
  }

  const cookieBuf = Buffer.from(String(cookieToken));
  const bodyBuf = Buffer.from(String(bodyToken));

  if (cookieBuf.length !== bodyBuf.length || !crypto.timingSafeEqual(cookieBuf, bodyBuf)) {
    logger.warn('Invalid CSRF token on POST /proxy/request', { ip: req.ip });
    return { ok: false, status: 403, message: 'Invalid CSRF token. Please reload the form and try again.' };
  }

  return { ok: true };
}

app.post('/proxy/request', cancelRateLimit, emailRateLimit, async (req, res) => {
  try {
    // Verify authentication (either App Proxy signature or CSRF token)
    const authResult = verifyRequestAuth(req, res);
    if (!authResult.ok) {
      return res.status(authResult.status).send(authResult.message);
    }

    const email = normalizeEmail(req.body.email);
    const orderNumber = normalizeOrderNumber(req.body.orderNumber);

    // Input validation
    if (!email || !orderNumber) {
      return res.status(400).send('Email and order number are required.');
    }

    // Email format validation (Fix #11)
    if (!EMAIL_REGEX.test(email)) {
      return res.status(400).send('Invalid email format.');
    }

    if (!isValidOrderNumber(orderNumber)) {
      return res.status(400).send('Invalid order number format.');
    }

    // Find and verify order
    const order = await findOrderByEmailAndName({ email, orderNumber });
    const cancelable = isOrderCancelable(order);

    if (!cancelable.ok) {
      return res.status(400).send(cancelable.reason);
    }

    // Check for existing pending request
    const existing = findPendingRequestForOrder(order.id);
    if (existing) {
      logger.info('Duplicate cancel request blocked', { orderId: order.id, email });
      return res.status(400).send('A pending cancellation request already exists for this order. Please check your email.');
    }

    // Generate token
    const token = createToken();
    const tokenHash = hashToken(token);
    const expiresAt = minutesFromNow(config.tokenTtlMinutes);
    const requestId = crypto.randomUUID();

    // Save the request FIRST with email_sent=0
    // This ensures the record exists before attempting email send
    saveRequest({
      id: requestId,
      tokenHash,
      shopDomain: config.shopDomain,
      orderId: order.id,
      orderNumber: order.name,
      email,
      status: 'pending_confirmation',
      expiresAt,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      usedAt: null,
      cancelledAt: null,
      ipAddress: req.ip,
    });

    // Attempt to send confirmation email immediately
    // If email send fails, leave email_sent=0 — the background queue will retry
    const confirmationUrl = `${config.appBaseUrl}/confirm?token=${encodeURIComponent(token)}`;
    try {
      await sendConfirmationEmail({
        to: email,
        orderNumber: order.name,
        confirmationUrl,
        ttlMinutes: config.tokenTtlMinutes,
      });
      // Mark email as sent successfully
      markEmailSent(requestId);
    } catch (emailError) {
      // Email send failed, log but don't error out
      // The background queue will retry
      logger.warn('Initial email send failed, will retry via queue', {
        requestId,
        email,
        error: emailError.message,
      });
    }

    auditLog('cancel_requested', {
      orderId: order.id,
      orderNumber: order.name,
      email,
      ip: req.ip,
      traceId: req.traceId,
    });

    const sentTemplate = fs.readFileSync(path.join(__dirname, '..', 'views', 'request-sent.html'), 'utf8');
    // Fix #5: Return application/liquid for App Proxy requests (via signature),
    // text/html for standalone form submissions (via CSRF)
    const hasAppProxySignature = Boolean(req.query.signature);
    const contentType = hasAppProxySignature ? 'application/liquid' : 'text/html';
    return res.type(contentType).send(sentTemplate.replace(/\{\{NONCE\}\}/g, res.locals.nonce));
  } catch (error) {
    logger.error('Cancel request failed', { error: error.message, stack: error.stack });
    return res.status(500).send('Could not process the cancellation request.');
  }
});

// ─── Confirmation (email link click, with rate limiting) ──────────────

app.get('/confirm', confirmRateLimit, async (req, res) => {
  try {
    const token = String(req.query.token || '');
    if (!token) {
      return res.status(400).send('Invalid token.');
    }

    const tokenHash = hashToken(token);
    const record = findRequestByTokenHash(tokenHash);

    if (!record) {
      return res.status(404).send('The request does not exist or is no longer valid.');
    }

    if (record.usedAt) {
      return res.status(400).send('This link has already been used.');
    }

    if (new Date(record.expiresAt).getTime() < Date.now()) {
      updateRequest(tokenHash, { status: 'expired' });
      return res.status(400).send('This link has expired. Please request a new cancellation.');
    }

    // Re-verify order state before cancelling
    // Fix #36: Use findOrderById (direct GID lookup) instead of findOrderByEmailAndName
    // which applies status:open + lookback filters that can exclude valid orders
    const order = await findOrderById(record.orderId);

    const cancelable = isOrderCancelable(order);
    if (!cancelable.ok) {
      updateRequest(tokenHash, { status: 'rejected_after_recheck' });
      return res.status(400).send(cancelable.reason);
    }

    // Check admin refund toggle
    const autoRefund = isAutoRefundEnabled();

    if (!autoRefund) {
      // Cancel WITHOUT refund — refund queued for admin approval
      const job = await cancelOrder(
        order.id,
        'Customer confirmed cancellation (refund pending admin approval)',
        { withRefund: false },
      );

      // Reflect pending-refund state in Shopify (tag + internal note)
      const now = new Date().toISOString();
      await addTagsToOrder(order.id, ['refund-pending']);
      await updateOrderNote(
        order.id,
        `Cancelled by customer — Refund pending admin approval (${now})`,
      );

      // Mark token as used atomically (Fix #4: TOCTTOU prevention)
      // Only succeeds if token hasn't been used yet (used_at IS NULL)
      const marked = markTokenAsUsed(
        tokenHash,
        'cancel_submitted',
        now,
        job?.id || null,
        'pending_approval',
      );

      if (!marked) {
        // Token was already used in another request (race condition)
        return res.status(400).send('This link has already been used.');
      }

      auditLog('cancel_confirmed_refund_pending', {
        orderId: order.id,
        orderNumber: record.orderNumber,
        email: record.email,
        jobId: job?.id,
        autoRefund: false,
        traceId: req.traceId,
      });
    } else {
      // Cancel WITH refund (original behavior)
      const job = await cancelOrder(
        order.id,
        'Customer confirmed cancellation by email link',
        { withRefund: true },
      );

      const now = new Date().toISOString();

      // Mark token as used atomically (Fix #4: TOCTTOU prevention)
      // Only succeeds if token hasn't been used yet (used_at IS NULL)
      const marked = markTokenAsUsed(
        tokenHash,
        'cancel_submitted',
        now,
        job?.id || null,
        'auto_refunded',
      );

      if (!marked) {
        // Token was already used in another request (race condition)
        return res.status(400).send('This link has already been used.');
      }

      auditLog('cancel_confirmed', {
        orderId: order.id,
        orderNumber: record.orderNumber,
        email: record.email,
        jobId: job?.id,
        autoRefund: true,
        traceId: req.traceId,
      });
    }

    const successTemplate = fs.readFileSync(path.join(__dirname, '..', 'views', 'success.html'), 'utf8');
    return res.type('html').send(successTemplate.replace(/\{\{NONCE\}\}/g, res.locals.nonce));
  } catch (error) {
    logger.error('Cancel confirmation failed', { error: error.message, stack: error.stack });
    return res.status(500).send('Could not confirm the cancellation. If the problem persists, please contact support.');
  }
});

// ═══════════════════════════════════════════════════════════════════════
// WEBHOOK ROUTES
// ═══════════════════════════════════════════════════════════════════════

// Webhook routes bypass CSRF, rate limiting, and session auth (use HMAC verification instead)

app.post('/webhooks/orders/updated', async (req, res) => {
  if (!verifyWebhookSignature(req)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }
  try {
    await handleOrderUpdated(req, res);
  } catch (error) {
    logger.error('Webhook handler error', { error: error.message });
    if (!res.headersSent) res.status(500).json({ error: 'Internal error' });
  }
});

app.post('/webhooks/orders/cancelled', async (req, res) => {
  if (!verifyWebhookSignature(req)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }
  try {
    await handleOrderCancelled(req, res);
  } catch (error) {
    logger.error('Webhook handler error', { error: error.message });
    if (!res.headersSent) res.status(500).json({ error: 'Internal error' });
  }
});

app.post('/webhooks/refunds/create', async (req, res) => {
  if (!verifyWebhookSignature(req)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }
  try {
    await handleRefundCreated(req, res);
  } catch (error) {
    logger.error('Webhook handler error', { error: error.message });
    if (!res.headersSent) res.status(500).json({ error: 'Internal error' });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// ADMIN ROUTES
// ═══════════════════════════════════════════════════════════════════════

app.post('/admin/login', adminLoginRateLimit, adminLogin);
app.get('/admin/logout', adminLogout);

// ─── Admin Dashboard ─────────────────────────────────────────────────
// Supports both standalone and embedded (Shopify Admin iframe) access.
// When ?shop= or ?embedded=1 is present, injects App Bridge CDN for embedding support.

app.get('/admin', requireAdmin, adminCsrfGenerate, (_req, res) => {
  const template = fs.readFileSync(path.join(__dirname, '..', 'views', 'admin.html'), 'utf8');
  const autoRefund = isAutoRefundEnabled();

  // Parse pagination parameters (Fix #27: guard against NaN from invalid input)
  const pageParam = parseInt(String(_req.query.page || '1'), 10);
  const page = Math.max(1, Number.isFinite(pageParam) ? pageParam : 1);
  const pageSize = 25;

  // Get paginated data
  const pendingResult = getPendingRefundsPaginated(page, pageSize);
  const recentResult = getRecentCancellationsPaginated(page, pageSize);

  const allowedFulfillment = getAllowedFulfillmentStatuses();
  const allowedFinancial = getAllowedFinancialStatuses();

  const flashType = _req.query.type === 'error' ? 'flash-error' : 'flash-success';
  // Fix #42: Remove redundant decodeURIComponent — Express already decodes query params.
  // The double-decode could throw URIError on malformed percent-encoded sequences.
  const flash = _req.query.msg
    ? `<div class="flash ${flashType}">${escapeHtml(String(_req.query.msg))}</div>`
    : '';

  // Build App Bridge CDN meta tag and script tag if API key is configured
  let appBridgeTags = '';
  if (config.shopifyApiKey) {
    appBridgeTags = `<meta name="shopify-api-key" content="${escapeHtml(config.shopifyApiKey)}" />
  <script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>`;
  }

  const html = template
    .replace(/\{\{NONCE\}\}/g, res.locals.nonce)
    .replace('{{SHOPIFY_APP_BRIDGE}}', appBridgeTags)
    .replace('{{AUTO_REFUND_CHECKED}}', autoRefund ? 'checked' : '')
    .replace('{{PENDING_COUNT}}', String(pendingResult.total))
    .replace('{{FLASH_MESSAGE}}', flash)
    .replace('{{CSRF_TOKEN}}', res.locals.adminCsrfToken)
    .replace('{{FULFILLMENT_CHECKBOXES}}', buildStatusCheckboxes(ALL_FULFILLMENT_STATUSES, allowedFulfillment, 'fulfillment'))
    .replace('{{FINANCIAL_CHECKBOXES}}', buildStatusCheckboxes(ALL_FINANCIAL_STATUSES, allowedFinancial, 'financial'))
    .replace('{{PENDING_TABLE}}', buildPendingTable(pendingResult.data))
    .replace('{{PENDING_PAGINATION}}', buildPagination('pending', pendingResult))
    .replace('{{RECENT_TABLE}}', buildRecentTable(recentResult.data))
    .replace('{{RECENT_PAGINATION}}', buildPagination('recent', recentResult));

  res.type('html').send(html);
});

// ─── Admin API: toggle auto-refund ───────────────────────────────────

app.post('/admin/api/settings', requireAdmin, adminSettingsRateLimit, adminCsrfValidate, (req, res) => {
  const { key, value } = req.body;

  // Handle the auto_refund toggle (legacy format)
  if ('auto_refund' in req.body && typeof req.body.auto_refund === 'boolean') {
    setSetting('auto_refund', String(req.body.auto_refund));
    auditLog('admin_setting_changed', { key: 'auto_refund', value: req.body.auto_refund, traceId: req.traceId });
    return res.json({ ok: true, auto_refund: req.body.auto_refund });
  }

  // Handle generic key/value settings
  const allowedKeys = ['auto_refund', 'allowed_fulfillment_statuses', 'allowed_financial_statuses'];
  if (!key || !allowedKeys.includes(key)) {
    return res.status(400).json({ error: `Invalid setting key. Allowed: ${allowedKeys.join(', ')}` });
  }

  // For status arrays, validate they're arrays of known values
  if (key === 'allowed_fulfillment_statuses') {
    if (!Array.isArray(value)) return res.status(400).json({ error: 'value must be an array' });
    const validValues = ALL_FULFILLMENT_STATUSES.map((s) => s.value);
    const invalid = value.filter((v) => !validValues.includes(v));
    if (invalid.length) return res.status(400).json({ error: `Invalid fulfillment statuses: ${invalid.join(', ')}` });
    if (value.length === 0) return res.status(400).json({ error: 'You must select at least one fulfillment status.' });
    setSetting(key, JSON.stringify(value));
  } else if (key === 'allowed_financial_statuses') {
    if (!Array.isArray(value)) return res.status(400).json({ error: 'value must be an array' });
    const validValues = ALL_FINANCIAL_STATUSES.map((s) => s.value);
    const invalid = value.filter((v) => !validValues.includes(v));
    if (invalid.length) return res.status(400).json({ error: `Invalid financial statuses: ${invalid.join(', ')}` });
    if (value.length === 0) return res.status(400).json({ error: 'You must select at least one financial status.' });
    setSetting(key, JSON.stringify(value));
  } else {
    setSetting(key, String(value));
  }

  auditLog('admin_setting_changed', { key, value, traceId: req.traceId });
  logger.info('Admin setting changed', { key, value });

  return res.json({ ok: true, key, value });
});

// ─── Admin: approve refund (Fix #6: Verify order state before refund) ─

app.post('/admin/refund/approve', requireAdmin, adminCsrfValidate, async (req, res) => {
  const { id } = req.body;
  // UUID validation (Fix #11)
  const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!id || !UUID_REGEX.test(String(id))) {
    return res.redirect('/admin?msg=Invalid request ID&type=error');
  }

  const record = findRequestById(id);
  if (!record) return res.redirect('/admin?msg=Request not found&type=error');

  // Validate full state machine
  if (record.status !== 'cancel_submitted') {
    return res.redirect('/admin?msg=The order was not properly cancelled. Cannot approve the refund.&type=error');
  }

  if (record.refundStatus !== 'pending_approval') {
    return res.redirect('/admin?msg=This refund has already been processed&type=error');
  }

  try {
    // Verify order state before approving refund (Fix #6)
    // Fix #30: Use findOrderById (direct GID lookup) instead of findOrderByEmailAndName
    // which applies lookback/status filters that exclude cancelled or old orders
    const currentOrder = await findOrderById(record.orderId);

    if (!currentOrder) {
      return res.redirect('/admin?msg=Order no longer exists in Shopify&type=error');
    }

    if (!currentOrder.cancelledAt) {
      return res.redirect('/admin?msg=Order is not cancelled in Shopify. Cannot refund.&type=error');
    }

    // Fix #51: Atomic state transition BEFORE calling Shopify API.
    // Only succeeds if still pending_approval, preventing concurrent double-approvals.
    const updated = atomicUpdateRefundById(id, 'pending_approval', {
      refundStatus: 'approved',
      refundedAt: new Date().toISOString(),
    });
    if (!updated) {
      return res.redirect('/admin?msg=This refund has already been processed by another admin&type=error');
    }

    const refund = await createOrderRefund(
      record.orderId,
      'Refund approved by admin',
      `refund-${record.tokenHash}`,
    );

    // Update Shopify order: remove pending tag, update note
    await removeTagsFromOrder(record.orderId, ['refund-pending']);
    await updateOrderNote(
      record.orderId,
      `Refund approved by admin (${new Date().toISOString()})`,
    );

    auditLog('refund_approved', {
      requestId: id,
      orderId: record.orderId,
      orderNumber: record.orderNumber,
      refundId: refund?.id,
      adminIp: req.ip,
      traceId: req.traceId,
    });

    return res.redirect(`/admin?msg=Refund approved for order ${encodeURIComponent(record.orderNumber)}&type=success`);
  } catch (error) {
    logger.error('Refund approval failed', { id, error: error.message });
    // Update DB refund_status to 'error' (Fix #13)
    updateRefundById(id, {
      refundStatus: 'error',
    });
    auditLog('refund_approval_error', {
      requestId: id,
      error: error.message,
      adminIp: req.ip,
      traceId: req.traceId,
    });
    // Fix #48: Use generic error message in URL to avoid leaking Shopify API internals.
    // Detailed error is already in the structured logs above.
    return res.redirect('/admin?msg=Error processing refund. Check server logs for details.&type=error');
  }
});

// ─── Admin: deny refund (Fix #5: CSRF + Fix #7: state validation) ───

app.post('/admin/refund/deny', requireAdmin, adminCsrfValidate, async (req, res) => {
  const { id } = req.body;
  // UUID validation (Fix #11)
  const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!id || !UUID_REGEX.test(String(id))) {
    return res.redirect('/admin?msg=Invalid request ID&type=error');
  }

  const record = findRequestById(id);
  if (!record) return res.redirect('/admin?msg=Request not found&type=error');

  // Validate full state machine (Fix #7)
  if (record.status !== 'cancel_submitted') {
    return res.redirect('/admin?msg=The order was not properly cancelled. Cannot process.&type=error');
  }

  if (record.refundStatus !== 'pending_approval') {
    return res.redirect('/admin?msg=This refund has already been processed&type=error');
  }

  try {
    // Fix #51: Atomic state transition — only succeeds if still pending_approval.
    const updated = atomicUpdateRefundById(id, 'pending_approval', { refundStatus: 'denied' });
    if (!updated) {
      return res.redirect('/admin?msg=This refund has already been processed by another admin&type=error');
    }

    // Update Shopify order: remove pending tag, update note
    await removeTagsFromOrder(record.orderId, ['refund-pending']);
    await updateOrderNote(
      record.orderId,
      `Refund denied by admin (${new Date().toISOString()})`,
    );

    auditLog('refund_denied', {
      requestId: id,
      orderId: record.orderId,
      orderNumber: record.orderNumber,
      adminIp: req.ip,
      traceId: req.traceId,
    });

    return res.redirect(`/admin?msg=Refund denied for order ${encodeURIComponent(record.orderNumber)}&type=success`);
  } catch (error) {
    logger.error('Refund denial failed', { id, error: error.message });
    // Fix #48: Generic error message to avoid leaking API internals in URL.
    return res.redirect('/admin?msg=Error denying refund. Check server logs for details.&type=error');
  }
});

// ─── Admin: webhook management (Fix #47: webhook resilience) ───────

/**
 * GET /admin/webhooks/list
 * List failed webhooks with pagination
 */
app.get('/admin/webhooks/list', requireAdmin, (_req, res) => {
  try {
    const page = Math.max(1, parseInt(String(_req.query.page || '1'), 10));
    const pageSize = 25;
    const result = getFailedWebhooks(page, pageSize);

    res.json({
      ok: true,
      data: result.data,
      pagination: {
        page: result.page,
        pageSize: result.pageSize,
        total: result.total,
        totalPages: result.totalPages,
      },
    });
  } catch (error) {
    logger.error('Failed to list webhooks', { error: error.message, traceId: _req.traceId });
    return res.status(500).json({ ok: false, error: 'Failed to list webhooks' });
  }
});

/**
 * POST /admin/webhooks/retry/:webhookId
 * Retry a failed webhook by re-fetching order state from Shopify and reprocessing
 */
app.post('/admin/webhooks/retry/:webhookId', requireAdmin, async (req, res) => {
  try {
    const { webhookId } = req.params;

    // Get the failed webhook record
    const failedWebhook = getFailedWebhookById(webhookId);
    if (!failedWebhook) {
      return res.status(404).json({ ok: false, error: 'Webhook not found' });
    }

    // Parse the payload summary to extract order ID
    let orderId;
    try {
      const summary = JSON.parse(failedWebhook.payload_summary || '{}');
      orderId = summary.orderId;
    } catch (e) {
      logger.warn('Could not parse webhook payload summary', { webhookId });
    }

    if (!orderId) {
      return res.status(400).json({ ok: false, error: 'Could not extract order ID from webhook' });
    }

    // Re-fetch current order state from Shopify
    const currentOrder = await findOrderById(`gid://shopify/Order/${orderId}`);
    if (!currentOrder) {
      return res.status(400).json({ ok: false, error: 'Order no longer exists in Shopify' });
    }

    // Check for pending cancel request
    const pending = findPendingRequestForOrder(`gid://shopify/Order/${orderId}`);
    if (!pending) {
      return res.json({
        ok: true,
        message: 'Webhook reprocessed, but no pending cancel request found for this order',
      });
    }

    // Update the cancel request based on current order state
    const cancelledAt = currentOrder.cancelledAt;
    const fulfillmentStatus = currentOrder.displayFulfillmentStatus || 'UNFULFILLED';

    if (cancelledAt) {
      updateRequest(pending.tokenHash, {
        status: 'cancelled_externally',
        cancelledAt,
      });
      auditLog('webhook_retry_success', {
        webhookId,
        orderId,
        action: 'order_cancelled',
        traceId: req.traceId,
      });
    } else {
      const allowedStatuses = getAllowedFulfillmentStatuses();
      if (!allowedStatuses.includes(fulfillmentStatus)) {
        updateRequest(pending.tokenHash, {
          status: 'rejected_order_fulfilled',
          refundStatus: 'denied',
        });
        auditLog('webhook_retry_success', {
          webhookId,
          orderId,
          action: 'order_fulfilled',
          traceId: req.traceId,
        });
      }
    }

    logger.info('Webhook retry completed', {
      webhookId,
      orderId,
      status: failedWebhook.status,
    });

    return res.json({ ok: true, message: 'Webhook reprocessed successfully' });
  } catch (error) {
    logger.error('Failed to retry webhook', { error: error.message, traceId: req.traceId });
    return res.status(500).json({ ok: false, error: 'Failed to retry webhook' });
  }
});

/**
 * GET /admin/webhooks/metrics
 * Get webhook metrics: success/failure counts by topic for last 24h
 */
app.get('/admin/webhooks/metrics', requireAdmin, (_req, res) => {
  try {
    const db = getDb();
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    // Get counts by status and topic for last 24h
    const stmt = db.prepare(`
      SELECT topic, status, COUNT(*) as count
      FROM webhook_processing_log
      WHERE created_at > ?
      GROUP BY topic, status
      ORDER BY topic, status
    `);

    const rows = stmt.all(oneDayAgo);

    // Aggregate data
    const metrics = {
      lastUpdated: new Date().toISOString(),
      last24h: {
        byTopic: {},
        totals: {
          succeeded: 0,
          failed: 0,
          skipped: 0,
        },
      },
    };

    rows.forEach((row) => {
      if (!metrics.last24h.byTopic[row.topic]) {
        metrics.last24h.byTopic[row.topic] = { succeeded: 0, failed: 0, skipped: 0 };
      }
      metrics.last24h.byTopic[row.topic][row.status] = row.count;
      metrics.last24h.totals[row.status] += row.count;
    });

    res.json({ ok: true, metrics });
  } catch (error) {
    logger.error('Failed to get webhook metrics', { error: error.message, traceId: _req.traceId });
    return res.status(500).json({ ok: false, error: 'Failed to get metrics' });
  }
});

// Global error handler — must be the last middleware
app.use(expressErrorHandler);

export default app;
