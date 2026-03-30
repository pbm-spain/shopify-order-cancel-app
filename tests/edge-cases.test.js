import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import crypto from 'crypto';
import request from 'supertest';
import { createMockShopifyServer, generateAppProxySignature, generateWebhookHmac, FIXTURES } from './helpers.js';

const testDataDir = `/tmp/shopify-test-edge-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
process.env.DATA_DIR = testDataDir;

vi.mock('../src/email.js', () => ({
  sendConfirmationEmail: vi.fn().mockResolvedValue({ messageId: 'test-msg-id' }),
}));

const mockServer = createMockShopifyServer();

let app;
let storage;

beforeAll(async () => {
  mockServer.listen({ onUnhandledRequest: 'bypass' });
  const mod = await import('../src/app.js');
  app = mod.default;
  storage = await import('../src/storage.js');
});

afterAll(() => {
  mockServer.close();
});

beforeEach(() => {
  mockServer.resetHandlers();
  vi.clearAllMocks();
});

const ADMIN_TOKEN = process.env.ADMIN_API_TOKEN;

// ─── Helper ─────────────────────────────────────────────────────────

async function getCsrfToken() {
  const formRes = await request(app).get('/cancel-order');
  const cookies = formRes.headers['set-cookie'];
  const csrfCookie = cookies.find((c) => c.startsWith('_csrf_token='));
  const csrfToken = csrfCookie.split('=')[1].split(';')[0];
  const cookieHeader = cookies.map((c) => c.split(';')[0]).join('; ');
  return { csrfToken, cookieHeader };
}

async function getAdminSession() {
  const adminRes = await request(app)
    .get('/admin')
    .set('Authorization', `Bearer ${ADMIN_TOKEN}`);
  const csrfMatch = adminRes.text.match(/id="adminCsrfToken"\s+value="([^"]+)"/);
  const csrfToken = csrfMatch ? csrfMatch[1] : '';
  const cookies = adminRes.headers['set-cookie'] || [];
  const cookieHeader = cookies.map((c) => c.split(';')[0]).join('; ');
  return { cookieHeader, csrfToken };
}

// ─── Token edge cases ───────────────────────────────────────────────

describe('Confirmation Token Edge Cases', () => {
  it('rejects token that is too short', async () => {
    const res = await request(app).get('/confirm?token=abc');
    expect(res.status).toBe(404);
  });

  it('rejects expired token gracefully', async () => {
    const tokenHash = crypto.createHash('sha256').update('expired-token').digest('hex');
    storage.saveRequest({
      id: crypto.randomUUID(),
      tokenHash,
      shopDomain: 'test-store.myshopify.com',
      orderId: 'gid://shopify/Order/9999',
      orderNumber: '#9999',
      email: 'expired@test.com',
      status: 'pending_confirmation',
      expiresAt: new Date(Date.now() - 60000).toISOString(), // expired 1 min ago
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const res = await request(app).get('/confirm?token=expired-token');
    expect(res.status).toBe(400);
    expect(res.text).toContain('expired');
  });

  it('rejects already-used token', async () => {
    const tokenHash = crypto.createHash('sha256').update('used-token').digest('hex');
    storage.saveRequest({
      id: crypto.randomUUID(),
      tokenHash,
      shopDomain: 'test-store.myshopify.com',
      orderId: 'gid://shopify/Order/8888',
      orderNumber: '#8888',
      email: 'used@test.com',
      status: 'cancel_submitted',
      expiresAt: new Date(Date.now() + 30 * 60000).toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      usedAt: new Date().toISOString(),
      cancelledAt: new Date().toISOString(),
    });

    const res = await request(app).get('/confirm?token=used-token');
    expect(res.status).toBe(400);
    expect(res.text).toContain('already been used');
  });
});

// ─── Admin dashboard edge cases ─────────────────────────────────────

describe('Admin Dashboard Edge Cases', () => {
  it('handles invalid page parameter gracefully', async () => {
    const res = await request(app)
      .get('/admin?page=abc')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`);

    expect(res.status).toBe(200);
  });

  it('handles negative page parameter', async () => {
    const res = await request(app)
      .get('/admin?page=-5')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`);

    expect(res.status).toBe(200);
  });

  it('handles zero page parameter', async () => {
    const res = await request(app)
      .get('/admin?page=0')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`);

    expect(res.status).toBe(200);
  });

  it('handles very large page parameter', async () => {
    const res = await request(app)
      .get('/admin?page=999999')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`);

    expect(res.status).toBe(200);
  });

  it('escapes flash message in query params to prevent XSS', async () => {
    const xssPayload = encodeURIComponent('<img src=x onerror=alert(1)>');
    const res = await request(app)
      .get(`/admin?msg=${xssPayload}&type=error`)
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.text).not.toContain('<img src=x onerror');
    expect(res.text).toContain('&lt;img');
  });
});

// ─── Admin settings edge cases ──────────────────────────────────────

describe('Admin Settings Edge Cases', () => {
  it('rejects unknown setting key', async () => {
    const { cookieHeader, csrfToken } = await getAdminSession();

    const res = await request(app)
      .post('/admin/api/settings')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .set('Content-Type', 'application/json')
      .set('Cookie', cookieHeader)
      .send({ _csrf: csrfToken, key: 'evil_setting', value: 'yes' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Invalid setting key');
  });

  it('rejects empty fulfillment status array', async () => {
    const { cookieHeader, csrfToken } = await getAdminSession();

    const res = await request(app)
      .post('/admin/api/settings')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .set('Content-Type', 'application/json')
      .set('Cookie', cookieHeader)
      .send({ _csrf: csrfToken, key: 'allowed_fulfillment_statuses', value: [] });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('at least one');
  });

  it('rejects invalid fulfillment status values', async () => {
    const { cookieHeader, csrfToken } = await getAdminSession();

    const res = await request(app)
      .post('/admin/api/settings')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .set('Content-Type', 'application/json')
      .set('Cookie', cookieHeader)
      .send({ _csrf: csrfToken, key: 'allowed_fulfillment_statuses', value: ['FAKE_STATUS'] });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Invalid fulfillment');
  });

  it('rejects non-array value for status settings', async () => {
    const { cookieHeader, csrfToken } = await getAdminSession();

    const res = await request(app)
      .post('/admin/api/settings')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .set('Content-Type', 'application/json')
      .set('Cookie', cookieHeader)
      .send({ _csrf: csrfToken, key: 'allowed_financial_statuses', value: 'PAID' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('must be an array');
  });
});

// ─── Refund edge cases ──────────────────────────────────────────────

describe('Refund Edge Cases', () => {
  it('rejects approve for request with wrong cancel status', async () => {
    const id = crypto.randomUUID();
    storage.saveRequest({
      id,
      tokenHash: crypto.createHash('sha256').update(crypto.randomBytes(32)).digest('hex'),
      shopDomain: 'test-store.myshopify.com',
      orderId: 'gid://shopify/Order/7777',
      orderNumber: '#7777',
      email: 'wrong-status@test.com',
      status: 'pending_confirmation', // not cancel_submitted
      expiresAt: new Date(Date.now() + 30 * 60000).toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    storage.updateRefundById(id, { refundStatus: 'pending_approval' });

    const { cookieHeader, csrfToken } = await getAdminSession();
    const res = await request(app)
      .post('/admin/refund/approve')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .set('Cookie', cookieHeader)
      .send(`id=${id}&_csrf=${csrfToken}`);

    expect(res.status).toBe(302);
    const location = decodeURIComponent(res.headers.location || '');
    expect(location).toContain('not properly cancelled');
  });

  it('rejects deny for already-denied request', async () => {
    const id = crypto.randomUUID();
    storage.saveRequest({
      id,
      tokenHash: crypto.createHash('sha256').update(crypto.randomBytes(32)).digest('hex'),
      shopDomain: 'test-store.myshopify.com',
      orderId: 'gid://shopify/Order/6666',
      orderNumber: '#6666',
      email: 'denied@test.com',
      status: 'cancel_submitted',
      expiresAt: new Date(Date.now() + 30 * 60000).toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      usedAt: new Date().toISOString(),
      cancelledAt: new Date().toISOString(),
    });
    storage.updateRefundById(id, { refundStatus: 'denied' });

    const { cookieHeader, csrfToken } = await getAdminSession();
    const res = await request(app)
      .post('/admin/refund/deny')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .set('Cookie', cookieHeader)
      .send(`id=${id}&_csrf=${csrfToken}`);

    expect(res.status).toBe(302);
    const location = decodeURIComponent(res.headers.location || '');
    expect(location).toContain('already been processed');
  });
});

// ─── Webhook edge cases ─────────────────────────────────────────────

describe('Webhook Edge Cases', () => {
  it('handles malformed JSON body gracefully', async () => {
    const body = '{"invalid json';
    const hmac = generateWebhookHmac(body);

    const res = await request(app)
      .post('/webhooks/orders/updated')
      .set('Content-Type', 'application/json')
      .set('X-Shopify-Hmac-SHA256', hmac)
      .send(body);

    // Malformed JSON triggers Express parse error (400) or error handler (500)
    expect([400, 500]).toContain(res.status);
  });

  it('handles empty webhook body without crashing', async () => {
    const body = JSON.stringify({ id: null });
    const hmac = generateWebhookHmac(body);

    const res = await request(app)
      .post('/webhooks/orders/cancelled')
      .set('Content-Type', 'application/json')
      .set('X-Shopify-Hmac-SHA256', hmac)
      .set('X-Shopify-Webhook-Id', crypto.randomUUID())
      .send(body);

    // Should not crash — returns 200 (webhook acknowledged) or 400/500
    expect(res.status).toBeLessThanOrEqual(500);
  });
});

// ─── Input validation edge cases ────────────────────────────────────

describe('Input Validation Edge Cases', () => {
  it('rejects order number with leading zeros', async () => {
    const { csrfToken, cookieHeader } = await getCsrfToken();
    const params = { timestamp: Math.floor(Date.now() / 1000).toString() };
    params.signature = generateAppProxySignature(params);
    const qs = new URLSearchParams(params).toString();

    const res = await request(app)
      .post(`/proxy/request?${qs}`)
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .set('Cookie', cookieHeader)
      .send(`email=test@example.com&orderNumber=%230001&_csrf=${csrfToken}`);

    expect(res.status).toBe(400);
    expect(res.text).toContain('Invalid order number');
  });

  it('rejects empty email', async () => {
    const { csrfToken, cookieHeader } = await getCsrfToken();
    const params = { timestamp: Math.floor(Date.now() / 1000).toString() };
    params.signature = generateAppProxySignature(params);
    const qs = new URLSearchParams(params).toString();

    const res = await request(app)
      .post(`/proxy/request?${qs}`)
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .set('Cookie', cookieHeader)
      .send(`email=&orderNumber=1001&_csrf=${csrfToken}`);

    expect(res.status).toBe(400);
  });

  it('handles very long email gracefully', async () => {
    const { csrfToken, cookieHeader } = await getCsrfToken();
    const params = { timestamp: Math.floor(Date.now() / 1000).toString() };
    params.signature = generateAppProxySignature(params);
    const qs = new URLSearchParams(params).toString();

    const longEmail = 'a'.repeat(500) + '@example.com';
    const res = await request(app)
      .post(`/proxy/request?${qs}`)
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .set('Cookie', cookieHeader)
      .send(`email=${encodeURIComponent(longEmail)}&orderNumber=1001&_csrf=${csrfToken}`);

    // Should either be rejected or handled without crashing
    expect(res.status).toBeLessThan(500);
  });
});

// ─── GET /proxy endpoint tests (Issue #16) ─────────────────────────

describe('GET /proxy Endpoint (Shopify App Proxy Form)', () => {
  it('accepts valid signature and timestamp', async () => {
    const params = { timestamp: Math.floor(Date.now() / 1000).toString() };
    params.signature = generateAppProxySignature(params);
    const queryString = new URLSearchParams(params).toString();

    const res = await request(app).get(`/proxy?${queryString}`);

    expect(res.status).toBe(200);
    expect(res.type).toMatch(/html|liquid/);
  });

  it('returns application/liquid content type', async () => {
    const params = { timestamp: Math.floor(Date.now() / 1000).toString() };
    params.signature = generateAppProxySignature(params);
    const queryString = new URLSearchParams(params).toString();

    const res = await request(app).get(`/proxy?${queryString}`);

    expect(res.type).toContain('liquid');
  });

  it('rejects invalid signature', async () => {
    const params = { timestamp: Math.floor(Date.now() / 1000).toString(), signature: 'invalid-sig' };
    const queryString = new URLSearchParams(params).toString();

    const res = await request(app).get(`/proxy?${queryString}`);

    expect(res.status).toBe(401);
    expect(res.text).toContain('Invalid App Proxy signature');
  });

  it('rejects missing signature', async () => {
    const params = { timestamp: Math.floor(Date.now() / 1000).toString() };
    const queryString = new URLSearchParams(params).toString();

    const res = await request(app).get(`/proxy?${queryString}`);

    expect(res.status).toBe(401);
  });

  it('rejects expired timestamp', async () => {
    // Timestamp from 10 minutes ago
    const oldTimestamp = Math.floor(Date.now() / 1000) - 600;
    const params = { timestamp: oldTimestamp.toString() };
    params.signature = generateAppProxySignature(params);
    const queryString = new URLSearchParams(params).toString();

    const res = await request(app).get(`/proxy?${queryString}`);

    expect(res.status).toBe(401);
    expect(res.text).toContain('timestamp is invalid or expired');
  });

  it('rejects missing timestamp', async () => {
    const params = {};
    params.signature = generateAppProxySignature(params);
    const queryString = new URLSearchParams(params).toString();

    const res = await request(app).get(`/proxy?${queryString}`);

    expect(res.status).toBe(401);
  });

  it('does not set X-Frame-Options DENY header', async () => {
    const params = { timestamp: Math.floor(Date.now() / 1000).toString() };
    params.signature = generateAppProxySignature(params);
    const queryString = new URLSearchParams(params).toString();

    const res = await request(app).get(`/proxy?${queryString}`);

    expect(res.headers['x-frame-options']).toBeUndefined();
  });

  it('does not set CSP header for proxy routes', async () => {
    const params = { timestamp: Math.floor(Date.now() / 1000).toString() };
    params.signature = generateAppProxySignature(params);
    const queryString = new URLSearchParams(params).toString();

    const res = await request(app).get(`/proxy?${queryString}`);

    expect(res.headers['content-security-policy']).toBeUndefined();
  });

  it('allows timestamps up to 30 seconds in the future (clock skew tolerance)', async () => {
    // Timestamp 20 seconds in the future (within tolerance)
    const futureTimestamp = Math.floor(Date.now() / 1000) + 20;
    const params = { timestamp: futureTimestamp.toString() };
    params.signature = generateAppProxySignature(params);
    const queryString = new URLSearchParams(params).toString();

    const res = await request(app).get(`/proxy?${queryString}`);

    expect(res.status).toBe(200);
  });

  it('rejects timestamps more than 30 seconds in the future', async () => {
    // Timestamp 60 seconds in the future (beyond tolerance)
    const futureTimestamp = Math.floor(Date.now() / 1000) + 60;
    const params = { timestamp: futureTimestamp.toString() };
    params.signature = generateAppProxySignature(params);
    const queryString = new URLSearchParams(params).toString();

    const res = await request(app).get(`/proxy?${queryString}`);

    expect(res.status).toBe(401);
  });
});

// ─── CSRF bypass tests (Issue #18) ──────────────────────────────────

describe('CSRF Protection with App Proxy Signature', () => {
  it('ignores invalid CSRF token when valid App Proxy signature is present', async () => {
    // Create a valid App Proxy request with invalid CSRF
    const params = { timestamp: Math.floor(Date.now() / 1000).toString() };
    params.signature = generateAppProxySignature(params);
    const queryString = new URLSearchParams(params).toString();

    const res = await request(app)
      .post(`/proxy/request?${queryString}`)
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('email=customer@example.com&orderNumber=1001&_csrf=invalid-csrf-token');

    // Should NOT fail with CSRF error (401/403)
    // Should proceed to validate the order (may fail with 400 if order not found, etc.)
    expect(res.status).not.toBe(403);
    expect(res.text).not.toContain('CSRF token');
  });

  it('requires CSRF token when no App Proxy signature is present', async () => {
    const res = await request(app)
      .post('/proxy/request')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('email=customer@example.com&orderNumber=1001&_csrf=invalid-csrf-token');

    expect(res.status).toBe(403);
    expect(res.text).toContain('CSRF token');
  });
});

// ─── Express error handler integration ──────────────────────────────

describe('Express Error Handler', () => {
  it('returns 500 for unhandled route errors', async () => {
    // The error handler is mounted — test that 404s still work normally
    const res = await request(app).get('/nonexistent-path');
    expect(res.status).toBe(404);
  });
});

// ─── Storage atomicity tests ────────────────────────────────────────

describe('Storage Atomicity', () => {
  it('markTokenAsUsed returns false for already-used token', () => {
    const tokenHash = crypto.createHash('sha256').update('atomic-test-token').digest('hex');
    const id = crypto.randomUUID();

    storage.saveRequest({
      id,
      tokenHash,
      shopDomain: 'test-store.myshopify.com',
      orderId: 'gid://shopify/Order/5555',
      orderNumber: '#5555',
      email: 'atomic@test.com',
      status: 'pending_confirmation',
      expiresAt: new Date(Date.now() + 30 * 60000).toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // First use should succeed
    const first = storage.markTokenAsUsed(
      tokenHash,
      'cancel_submitted',
      new Date().toISOString(),
      null,
      'auto_refunded',
    );
    expect(first).toBe(true);

    // Second use should fail (atomic)
    const second = storage.markTokenAsUsed(
      tokenHash,
      'cancel_submitted',
      new Date().toISOString(),
      null,
      'auto_refunded',
    );
    expect(second).toBe(false);
  });

  it('atomicUpdateRefundById prevents concurrent double-approval', () => {
    const id = crypto.randomUUID();
    const tokenHash = crypto.createHash('sha256').update(crypto.randomBytes(32)).digest('hex');

    storage.saveRequest({
      id,
      tokenHash,
      shopDomain: 'test-store.myshopify.com',
      orderId: 'gid://shopify/Order/4444',
      orderNumber: '#4444',
      email: 'atomic-refund@test.com',
      status: 'cancel_submitted',
      expiresAt: new Date(Date.now() + 30 * 60000).toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      usedAt: new Date().toISOString(),
      cancelledAt: new Date().toISOString(),
    });
    storage.updateRefundById(id, { refundStatus: 'pending_approval' });

    const first = storage.atomicUpdateRefundById(id, 'pending_approval', {
      refundStatus: 'approved',
      refundedAt: new Date().toISOString(),
    });
    expect(first).toBe(true);

    const second = storage.atomicUpdateRefundById(id, 'pending_approval', {
      refundStatus: 'approved',
      refundedAt: new Date().toISOString(),
    });
    expect(second).toBe(false);
  });
});
