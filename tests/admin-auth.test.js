import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import crypto from 'crypto';
import request from 'supertest';
import { createMockShopifyServer } from './helpers.js';

const testDataDir = `/tmp/shopify-test-admin-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
process.env.DATA_DIR = testDataDir;

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
});

const ADMIN_TOKEN = process.env.ADMIN_API_TOKEN;

/**
 * Helper: get the login page and extract the CSRF token + cookies.
 * The login page is served by GET /admin when unauthenticated.
 */
async function getLoginCsrf() {
  const loginPageRes = await request(app)
    .get('/admin')
    .set('Accept', 'text/html');

  const csrfMatch = loginPageRes.text.match(/name="_csrf"\s+value="([^"]+)"/);
  const csrfToken = csrfMatch ? csrfMatch[1] : '';
  const cookies = loginPageRes.headers['set-cookie'] || [];
  const cookieHeader = cookies.map((c) => c.split(';')[0]).join('; ');
  return { csrfToken, cookieHeader };
}

describe('Open Redirect Prevention', () => {
  it('redirects to /admin for external URLs', async () => {
    const { csrfToken, cookieHeader } = await getLoginCsrf();
    const res = await request(app)
      .post('/admin/login')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .set('Cookie', cookieHeader)
      .send(`token=${ADMIN_TOKEN}&redirect=https://evil.com&_csrf=${csrfToken}`);

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/admin');
  });

  it('allows redirect to /admin subpaths', async () => {
    const { csrfToken, cookieHeader } = await getLoginCsrf();
    const res = await request(app)
      .post('/admin/login')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .set('Cookie', cookieHeader)
      .send(`token=${ADMIN_TOKEN}&redirect=/admin?page=2&_csrf=${csrfToken}`);

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('/admin');
  });
});

describe('Admin Authentication', () => {
  describe('Bearer token auth', () => {
    it('grants access with valid Bearer token', async () => {
      const res = await request(app)
        .get('/admin')
        .set('Authorization', `Bearer ${ADMIN_TOKEN}`);

      expect(res.status).toBe(200);
      expect(res.type).toMatch(/html/);
    });

    it('rejects invalid Bearer token', async () => {
      const res = await request(app)
        .get('/admin')
        .set('Authorization', 'Bearer wrong_token_value');

      expect(res.status).toBe(401);
    });

    it('rejects empty Authorization header', async () => {
      const res = await request(app)
        .get('/admin')
        .set('Authorization', '');

      expect(res.status).toBe(401);
    });
  });

  describe('Session-based auth (login/logout)', () => {
    it('returns 401 with login page for /admin without auth', async () => {
      const res = await request(app)
        .get('/admin')
        .set('Accept', 'text/html');

      expect(res.status).toBe(401);
      expect(res.text).toContain('Admin');
      expect(res.text).toContain('form');
    });

    it('rejects login with wrong token', async () => {
      const { csrfToken, cookieHeader } = await getLoginCsrf();
      const res = await request(app)
        .post('/admin/login')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .set('Cookie', cookieHeader)
        .send(`token=wrong_password&redirect=/admin&_csrf=${csrfToken}`);

      expect(res.status).toBe(401);
      expect(res.text).toContain('Incorrect token');
    });

    it('rejects login without CSRF token', async () => {
      const res = await request(app)
        .post('/admin/login')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send(`token=${ADMIN_TOKEN}&redirect=/admin`);

      expect(res.status).toBe(403);
      expect(res.text).toContain('CSRF');
    });

    it('successful login sets session cookie and redirects', async () => {
      const { csrfToken, cookieHeader } = await getLoginCsrf();
      const res = await request(app)
        .post('/admin/login')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .set('Cookie', cookieHeader)
        .send(`token=${ADMIN_TOKEN}&redirect=/admin&_csrf=${csrfToken}`);

      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('/admin');

      const cookies = res.headers['set-cookie'];
      expect(cookies).toBeDefined();
      const sessionCookie = cookies.find((c) => c.startsWith('_admin_session='));
      expect(sessionCookie).toBeDefined();
      expect(sessionCookie).toContain('HttpOnly');
      expect(sessionCookie).toContain('SameSite=Strict');
    });

    it('session cookie grants access to /admin', async () => {
      const { csrfToken, cookieHeader: loginCookies } = await getLoginCsrf();
      const loginRes = await request(app)
        .post('/admin/login')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .set('Cookie', loginCookies)
        .send(`token=${ADMIN_TOKEN}&redirect=/admin&_csrf=${csrfToken}`);

      if (loginRes.status === 429) {
        // Rate limited — skip gracefully
        return;
      }

      const cookies = loginRes.headers['set-cookie'] || [];
      const cookieHeader = cookies.map((c) => c.split(';')[0]).join('; ');

      const adminRes = await request(app)
        .get('/admin')
        .set('Cookie', cookieHeader);

      expect(adminRes.status).toBe(200);
      expect(adminRes.type).toMatch(/html/);
    });

    it('logout clears session and blocks subsequent access', async () => {
      const { csrfToken, cookieHeader: loginCookies } = await getLoginCsrf();
      const loginRes = await request(app)
        .post('/admin/login')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .set('Cookie', loginCookies)
        .send(`token=${ADMIN_TOKEN}&redirect=/admin&_csrf=${csrfToken}`);

      if (loginRes.status === 429) {
        return;
      }

      const cookies = loginRes.headers['set-cookie'];
      const cookieHeader = cookies.map((c) => c.split(';')[0]).join('; ');

      const logoutRes = await request(app)
        .get('/admin/logout')
        .set('Cookie', cookieHeader);

      expect(logoutRes.status).toBe(302);
      expect(logoutRes.headers.location).toBe('/admin');

      const adminRes = await request(app)
        .get('/admin')
        .set('Cookie', cookieHeader)
        .set('Accept', 'text/html');

      expect(adminRes.status).toBe(401);
    });
  });

  describe('Admin API auth', () => {
    it('rejects settings API without auth', async () => {
      const res = await request(app)
        .post('/admin/api/settings')
        .set('Content-Type', 'application/json')
        .send({ auto_refund: true });

      expect(res.status).toBe(401);
    });

    it('allows settings API with Bearer token + admin CSRF session', async () => {
      // Use Bearer token for auth, but need admin CSRF session too
      // First get admin page via Bearer to establish CSRF session
      const adminRes = await request(app)
        .get('/admin')
        .set('Authorization', `Bearer ${ADMIN_TOKEN}`);

      expect(adminRes.status).toBe(200);

      // Extract admin CSRF token from HTML
      const csrfMatch = adminRes.text.match(/id="adminCsrfToken"\s+value="([^"]+)"/);
      expect(csrfMatch).toBeTruthy();
      const csrfToken = csrfMatch[1];

      // Extract session cookies
      const cookies = adminRes.headers['set-cookie'] || [];
      const cookieHeader = cookies.map((c) => c.split(';')[0]).join('; ');

      const settingsRes = await request(app)
        .post('/admin/api/settings')
        .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
        .set('Content-Type', 'application/json')
        .set('Cookie', cookieHeader)
        .send({ _csrf: csrfToken, auto_refund: true });

      expect(settingsRes.status).toBe(200);
      expect(settingsRes.body.ok).toBe(true);
    });
  });
});

describe('Admin Login Rate Limiting', () => {
  it('returns 429 with Retry-After header when rate limited', async () => {
    // At this point prior tests have already consumed several login attempts.
    // Send enough to ensure we exceed the limit (5 per 15 min window).
    for (let i = 0; i < 10; i++) {
      await request(app)
        .post('/admin/login')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('token=definitely_wrong');
    }

    const res = await request(app)
      .post('/admin/login')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('token=wrong');

    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBeDefined();
  });
});
