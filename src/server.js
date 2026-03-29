import express from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import cookieParser from 'cookie-parser';
import { fileURLToPath } from 'url';
import { config } from './config.js';
import { verifyAppProxySignature } from './appProxy.js';
import {
  cancelOrder, createOrderRefund, findOrderByEmailAndName, findOrderById, isOrderCancelable,
  addTagsToOrder, removeTagsFromOrder, updateOrderNote,
  ALL_FULFILLMENT_STATUSES, ALL_FINANCIAL_STATUSES,
} from './shopify.js';
import { createToken, hashToken, minutesFromNow, normalizeEmail, normalizeOrderNumber, isValidOrderNumber, escapeHtml } from './utils.js';
import {
  saveRequest, findRequestByTokenHash, updateRequest, markTokenAsUsed,
  findPendingRequestForOrder, findRequestById,
  updateRefundById, isAutoRefundEnabled,
  getAllowedFulfillmentStatuses, getAllowedFinancialStatuses,
  setSetting, closeDb, getPendingRefundsPaginated, getRecentCancellationsPaginated,
  markEmailSent, getDb, cleanupOldWebhookEvents,
} from './storage.js';
import { sendConfirmationEmail } from './email.js';
import { rateLimit } from './rateLimit.js';
import { csrfGenerate, csrfValidate } from './csrf.js';
import { requireAdmin, adminLogin, adminLogout, startSessionCleanup, stopSessionCleanup } from './adminAuth.js';
import { logger, auditLog } from './logger.js';
import { verifyWebhookSignature, handleOrderUpdated, handleOrderCancelled, handleRefundCreated } from './webhooks.js';
import { startEmailQueue, stopEmailQueue } from './emailQueue.js';

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

app.use((_req, res, next) => {
  const nonce = crypto.randomBytes(16).toString('hex');
  res.locals.nonce = nonce;

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader(
    'Content-Security-Policy',
    `default-src 'self'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'nonce-${nonce}';`,
  );
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
    res.json({ ok: true, version: '0.8.9' });
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

// ─── Cancellation Request (App Proxy POST) ───────────────────────────

app.post('/proxy/request', cancelRateLimit, csrfValidate, emailRateLimit, async (req, res) => {
  try {
    // Verify App Proxy HMAC signature
    const signatureOk = verifyAppProxySignature(req.query);
    if (!signatureOk) {
      logger.warn('Invalid app proxy signature', { ip: req.ip });
      return res.status(401).send('Invalid App Proxy signature.');
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
    return res.type('html').send(sentTemplate.replace(/\{\{NONCE\}\}/g, res.locals.nonce));
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

// ─── Admin CSRF token (Fix #2-4: simplified session-based approach) ───
// Maps session IDs to their CSRF tokens (session data stored here)
const adminSessions = new Map();

// Cleanup expired sessions every 10 minutes
// Fix #38: Store interval reference so it can be stopped during shutdown
const adminSessionCleanupInterval = setInterval(() => {
  try {
    const now = Date.now();
    const maxAge = 8 * 60 * 60 * 1000;
    for (const [sessionId, { createdAt }] of adminSessions) {
      if (now - createdAt > maxAge) {
        adminSessions.delete(sessionId);
      }
    }
  } catch { /* cleanup failure is non-fatal */ }
}, 10 * 60 * 1000);
adminSessionCleanupInterval.unref();

function adminCsrfGenerate(req, res, next) {
  // Fix #47: Reuse existing CSRF token for the session instead of regenerating
  // on every page load. Regenerating caused stale-token errors when admins had
  // multiple tabs or refreshed while a form was open.
  const sessionId = req.cookies?._admin_session_id || crypto.randomBytes(16).toString('hex');

  let session = adminSessions.get(sessionId);
  if (!session || !session.csrfToken) {
    // Only generate a new token when the session is new or missing a token
    const csrfToken = crypto.randomBytes(32).toString('hex');
    session = { csrfToken, createdAt: Date.now() };
    adminSessions.set(sessionId, session);
  }

  res.cookie('_admin_session_id', sessionId, {
    httpOnly: true,
    sameSite: 'Strict',
    secure: config.appBaseUrl.startsWith('https'),
    maxAge: 8 * 60 * 60 * 1000,
  });

  res.locals.adminCsrfToken = session.csrfToken;
  next();
}

function adminCsrfValidate(req, res, next) {
  const sessionId = req.cookies?._admin_session_id || '';
  const bodyToken = req.body?._csrf || '';

  if (!sessionId || !bodyToken) {
    return res.redirect('/admin?msg=Invalid CSRF token. Please reload the page.&type=error');
  }

  // Verify session exists and token matches
  const session = adminSessions.get(sessionId);
  if (!session) {
    return res.redirect('/admin?msg=Invalid session. Please reload the page.&type=error');
  }

  // Timing-safe comparison to prevent timing attacks
  const storedBuf = Buffer.from(String(session.csrfToken));
  const bodyBuf = Buffer.from(String(bodyToken));
  if (storedBuf.length !== bodyBuf.length || !crypto.timingSafeEqual(storedBuf, bodyBuf)) {
    return res.redirect('/admin?msg=Invalid CSRF token. Please reload the page.&type=error');
  }

  next();
}

// ─── Admin Dashboard ─────────────────────────────────────────────────

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

  const html = template
    .replace(/\{\{NONCE\}\}/g, res.locals.nonce)
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

    updateRefundById(id, {
      refundStatus: 'approved',
      refundedAt: new Date().toISOString(),
    });

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
    updateRefundById(id, { refundStatus: 'denied' });

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

// ═══════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════

function buildStatusCheckboxes(allStatuses, allowed, groupName) {
  return allStatuses.map((s) => {
    const checked = allowed.includes(s.value) ? 'checked' : '';
    return `<label class="cb-label">
      <input type="checkbox" value="${s.value}" data-group="${groupName}" ${checked} />
      <span class="cb-text">${escapeHtml(s.label)}</span>
      <code class="cb-code">${s.value}</code>
    </label>`;
  }).join('\n');
}

function formatDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-US', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function refundBadge(status) {
  const map = {
    none: '',
    pending_approval: '<span class="status-badge badge-pending">Pending</span>',
    approved: '<span class="status-badge badge-approved">Approved</span>',
    denied: '<span class="status-badge badge-denied">Denied</span>',
    auto_refunded: '<span class="status-badge badge-auto">Automatic</span>',
    error: '<span class="status-badge badge-denied">Error</span>',
  };
  return map[status] || escapeHtml(String(status));
}

function buildPagination(tableType, result) {
  const { page, totalPages } = result;

  if (totalPages <= 1) {
    return '';
  }

  const prevDisabled = page === 1 ? 'disabled' : '';
  const nextDisabled = page === totalPages ? 'disabled' : '';

  // tableType is hardcoded at build time (either 'pending' or 'recent') and safe from injection
  return `
    <div class="pagination">
      <button class="pagination-btn" onclick="goToPage(${Math.max(1, page - 1)}, '${tableType}')" ${prevDisabled}>
        Previous
      </button>
      <span class="pagination-info">Page ${page} of ${totalPages}</span>
      <button class="pagination-btn" onclick="goToPage(${Math.min(totalPages, page + 1)}, '${tableType}')" ${nextDisabled}>
        Next
      </button>
    </div>
  `;
}

function buildPendingTable(pending) {
  if (pending.length === 0) {
    return '<p class="empty">No pending refunds awaiting approval.</p>';
  }
  const rows = pending.map((r) => `
    <tr>
      <td><strong>${escapeHtml(r.orderNumber)}</strong></td>
      <td>${escapeHtml(r.email)}</td>
      <td>${formatDate(r.cancelledAt)}</td>
      <td>
        <button class="btn btn-approve" data-action="approve" data-id="${escapeHtml(r.id)}">Approve</button>
        <button class="btn btn-deny" data-action="deny" data-id="${escapeHtml(r.id)}">Deny</button>
      </td>
    </tr>
  `).join('');

  return `<table>
    <thead><tr><th>Order</th><th>Email</th><th>Cancelled</th><th>Actions</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function buildRecentTable(recent) {
  if (recent.length === 0) {
    return '<p class="empty">No recent cancellations.</p>';
  }
  const rows = recent.map((r) => `
    <tr>
      <td><strong>${escapeHtml(r.orderNumber)}</strong></td>
      <td>${escapeHtml(r.email)}</td>
      <td>${formatDate(r.cancelledAt)}</td>
      <td>${refundBadge(r.refundStatus)}</td>
    </tr>
  `).join('');

  return `<table>
    <thead><tr><th>Order</th><th>Email</th><th>Cancelled</th><th>Refund</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

// ─── Graceful shutdown (Fix #13) ──────────────────────────────────────

function shutdown() {
  logger.info('Shutting down gracefully...');

  // Stop background workers (each manages its own interval)
  try { stopEmailQueue(); } catch (e) { logger.warn('Failed to stop email queue', { error: e.message }); }
  try { stopSessionCleanup(); } catch (e) { logger.warn('Failed to stop session cleanup', { error: e.message }); }
  // Fix #38: Stop admin session cleanup interval
  try { clearInterval(adminSessionCleanupInterval); } catch (e) { logger.warn('Failed to stop admin session cleanup', { error: e.message }); }

  // Close database
  try {
    closeDb();
  } catch (error) {
    logger.error('Error closing database', { error: error.message });
  }

  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ─── Start ───────────────────────────────────────────────────────────

// Start email queue worker
startEmailQueue();

// Start webhook cleanup (Fix #12): run on startup and every 24 hours
try {
  cleanupOldWebhookEvents(30);
} catch (error) {
  logger.warn('Initial webhook cleanup failed', { error: error.message });
}

// Schedule webhook cleanup every 24 hours
setInterval(() => {
  try {
    cleanupOldWebhookEvents(30);
  } catch (error) {
    logger.error('Scheduled webhook cleanup failed', { error: error.message });
  }
}, 24 * 60 * 60 * 1000).unref();

// Start background workers
startSessionCleanup();

app.listen(config.port, () => {
  logger.info('Server started', { port: config.port, apiVersion: config.apiVersion });
});
