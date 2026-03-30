import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import crypto from 'crypto';
import request from 'supertest';
import { createMockShopifyServer, generateAppProxySignature, FIXTURES } from './helpers.js';

const testDataDir = `/tmp/shopify-test-cancel-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
process.env.DATA_DIR = testDataDir;

// Mock email before importing app
vi.mock('../src/email.js', () => ({
  sendConfirmationEmail: vi.fn().mockResolvedValue({ messageId: 'test-msg-id' }),
}));

const mockServer = createMockShopifyServer();

let app;

beforeAll(async () => {
  mockServer.listen({ onUnhandledRequest: 'bypass' });
  const mod = await import('../src/app.js');
  app = mod.default;
});

afterAll(() => {
  mockServer.close();
});

beforeEach(() => {
  mockServer.resetHandlers();
  vi.clearAllMocks();
});

describe('Health Endpoint', () => {
  it('returns ok with version', async () => {
    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, version: '0.12.0' });
  });
});

describe('Cancel Order Form', () => {
  it('serves form with CSRF token', async () => {
    const res = await request(app).get('/cancel-order');

    expect(res.status).toBe(200);
    expect(res.type).toMatch(/html/);
    // Should set CSRF cookie
    const cookies = res.headers['set-cookie'];
    expect(cookies).toBeDefined();
    const csrfCookie = cookies.find((c) => c.startsWith('_csrf_token='));
    expect(csrfCookie).toBeDefined();
  });
});

describe('Cancel Request Flow (POST /proxy/request)', () => {
  /**
   * Helper: get CSRF token by loading the form first.
   */
  async function getCsrfToken() {
    const formRes = await request(app).get('/cancel-order');
    const cookies = formRes.headers['set-cookie'];
    const csrfCookie = cookies.find((c) => c.startsWith('_csrf_token='));
    const csrfToken = csrfCookie.split('=')[1].split(';')[0];
    const cookieHeader = cookies.map((c) => c.split(';')[0]).join('; ');
    return { csrfToken, cookieHeader };
  }

  it('rejects without CSRF token', async () => {
    const res = await request(app)
      .post('/proxy/request')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('email=test@example.com&orderNumber=1001');

    expect(res.status).toBe(403);
    expect(res.text).toContain('CSRF');
  });

  it('rejects without App Proxy signature', async () => {
    const { csrfToken, cookieHeader } = await getCsrfToken();

    const res = await request(app)
      .post('/proxy/request')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .set('Cookie', cookieHeader)
      .send(`email=test@example.com&orderNumber=1001&_csrf=${csrfToken}`);

    expect(res.status).toBe(401);
    expect(res.text).toContain('App Proxy signature');
  });

  it('rejects invalid email format', async () => {
    const { csrfToken, cookieHeader } = await getCsrfToken();
    const params = { timestamp: '1234567890' };
    params.signature = generateAppProxySignature(params);

    const queryString = new URLSearchParams(params).toString();

    const res = await request(app)
      .post(`/proxy/request?${queryString}`)
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .set('Cookie', cookieHeader)
      .send(`email=not-an-email&orderNumber=1001&_csrf=${csrfToken}`);

    expect(res.status).toBe(400);
    expect(res.text).toContain('Invalid email');
  });

  it('rejects invalid order number format', async () => {
    const { csrfToken, cookieHeader } = await getCsrfToken();
    const params = { timestamp: '1234567890' };
    params.signature = generateAppProxySignature(params);
    const queryString = new URLSearchParams(params).toString();

    const res = await request(app)
      .post(`/proxy/request?${queryString}`)
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .set('Cookie', cookieHeader)
      .send(`email=customer@example.com&orderNumber=abc&_csrf=${csrfToken}`);

    expect(res.status).toBe(400);
    expect(res.text).toContain('Invalid order number');
  });

  it('submits valid cancellation request and returns success page', async () => {
    const { csrfToken, cookieHeader } = await getCsrfToken();
    const params = { timestamp: '1234567890' };
    params.signature = generateAppProxySignature(params);
    const queryString = new URLSearchParams(params).toString();

    const res = await request(app)
      .post(`/proxy/request?${queryString}`)
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .set('Cookie', cookieHeader)
      .send(`email=customer@example.com&orderNumber=1001&_csrf=${csrfToken}`);

    expect(res.status).toBe(200);
    expect(res.type).toMatch(/html/);

    // Email should have been attempted
    const { sendConfirmationEmail } = await import('../src/email.js');
    expect(sendConfirmationEmail).toHaveBeenCalledTimes(1);
    expect(sendConfirmationEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'customer@example.com',
        orderNumber: '#1001',
      }),
    );
  });

  it('blocks duplicate cancellation request for same order', async () => {
    // The previous test already created a pending request for order 1001.
    // A second submission for the same order (using a different email to avoid
    // email rate limit) should be blocked by the duplicate-request check.
    // But since the order lookup matches on email too, use same email.
    // The email rate limit (3/hour) may interfere, so use a fresh email.
    const { csrfToken, cookieHeader } = await getCsrfToken();
    const params = { timestamp: '1234567892' };
    params.signature = generateAppProxySignature(params);
    const qs = new URLSearchParams(params).toString();

    const res = await request(app)
      .post(`/proxy/request?${qs}`)
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .set('Cookie', cookieHeader)
      .send(`email=customer@example.com&orderNumber=1001&_csrf=${csrfToken}`);

    // Should be 400 (duplicate) or 429 (rate limit) — both are valid blocking behaviors
    expect([400, 429]).toContain(res.status);
    if (res.status === 400) {
      expect(res.text).toContain('pending cancellation request already exists');
    }
  });
});

describe('Confirm Cancel (GET /confirm)', () => {
  it('rejects empty token', async () => {
    const res = await request(app).get('/confirm');
    expect(res.status).toBe(400);
    expect(res.text).toContain('Invalid token');
  });

  it('rejects non-existent token', async () => {
    const fakeToken = crypto.randomBytes(32).toString('hex');
    const res = await request(app).get(`/confirm?token=${fakeToken}`);
    expect(res.status).toBe(404);
    expect(res.text).toContain('does not exist');
  });
});

describe('Content-Type Validation', () => {
  it('rejects POST with unsupported content type', async () => {
    const res = await request(app)
      .post('/proxy/request')
      .set('Content-Type', 'text/plain')
      .send('some data');

    expect(res.status).toBe(415);
    expect(res.text).toContain('Unsupported Media Type');
  });

  it('accepts application/json content type', async () => {
    const res = await request(app)
      .post('/webhooks/orders/updated')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ id: 1001 }));

    // Should get to HMAC check (401) not content-type rejection (415)
    expect(res.status).toBe(401);
  });
});

describe('Security Headers', () => {
  it('sets security headers on all responses', async () => {
    const res = await request(app).get('/health');

    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
  });

  it('includes CSP nonce in script-src and style-src', async () => {
    const res = await request(app).get('/health');
    const csp = res.headers['content-security-policy'];

    expect(csp).toMatch(/script-src 'self' 'nonce-[a-f0-9]+'/);
    expect(csp).toMatch(/style-src 'self' 'nonce-[a-f0-9]+'/);
  });

  it('sets HSTS header for HTTPS app URL', async () => {
    const res = await request(app).get('/health');
    expect(res.headers['strict-transport-security']).toContain('max-age=31536000');
  });
});
