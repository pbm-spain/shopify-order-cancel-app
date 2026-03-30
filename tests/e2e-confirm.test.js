/**
 * End-to-end test: full cancellation confirmation happy path.
 *
 * Exercises the complete flow:
 *   1. POST /proxy/request → create cancel request, send confirmation email
 *   2. Extract token from the email mock's arguments
 *   3. GET /confirm?token=... → Shopify cancelOrder mock → success page
 *   4. Verify DB state is updated correctly
 *
 * Covers both auto-refund and manual-refund (pending admin approval) paths.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import crypto from 'crypto';
import request from 'supertest';
import { http, HttpResponse } from 'msw';
import { createMockShopifyServer, generateAppProxySignature, FIXTURES } from './helpers.js';

const testDataDir = `/tmp/shopify-test-e2e-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
process.env.DATA_DIR = testDataDir;

// Mock email — capture calls so we can extract the confirmation URL
const mockSendEmail = vi.fn().mockResolvedValue({ messageId: 'test-msg-id' });
vi.mock('../src/email.js', () => ({
  sendConfirmationEmail: mockSendEmail,
}));

const mockServer = createMockShopifyServer();
const graphqlUrl = `https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/${process.env.SHOPIFY_ADMIN_API_VERSION}/graphql.json`;

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

/**
 * Helper: get CSRF token from the cancel form page.
 */
async function getCsrfToken() {
  const formRes = await request(app).get('/cancel-order');
  const cookies = formRes.headers['set-cookie'];
  const csrfCookie = cookies.find((c) => c.startsWith('_csrf_token='));
  const csrfToken = csrfCookie.split('=')[1].split(';')[0];
  const cookieHeader = cookies.map((c) => c.split(';')[0]).join('; ');
  return { csrfToken, cookieHeader };
}

/**
 * Helper: extract the confirmation token from the mocked email call.
 */
function extractTokenFromEmail() {
  expect(mockSendEmail).toHaveBeenCalled();
  const emailArgs = mockSendEmail.mock.calls[0][0];
  const url = new URL(emailArgs.confirmationUrl);
  return url.searchParams.get('token');
}

describe('E2E: Full Confirmation Happy Path (auto-refund)', () => {
  it('creates request → confirms via token → cancels order with refund → updates DB', async () => {
    // Ensure auto-refund is enabled
    storage.setSetting('auto_refund', 'true');

    // Override MSW to handle the full cancel + refund flow
    mockServer.use(
      http.post(graphqlUrl, async ({ request: req }) => {
        const body = await req.json();
        const query = body.query || '';

        // Order lookup by email+name (findOrderByEmailAndName)
        if (query.includes('orders(first:') || query.includes('orders(query:')) {
          return HttpResponse.json({
            data: { orders: { edges: [{ node: FIXTURES.order }] } },
          });
        }

        // Direct order lookup by ID (findOrderById — re-verify before cancel)
        if (query.includes('order(id:') || query.includes('node(id:')) {
          return HttpResponse.json({
            data: { order: FIXTURES.order },
          });
        }

        // orderCancel mutation
        if (query.includes('orderCancel')) {
          return HttpResponse.json({
            data: {
              orderCancel: {
                job: FIXTURES.cancelJob,
                orderCancelUserErrors: [],
              },
            },
          });
        }

        // tagsAdd (for refund-pending tag in manual-refund path)
        if (query.includes('tagsAdd')) {
          return HttpResponse.json({
            data: { tagsAdd: { node: { id: FIXTURES.order.id }, userErrors: [] } },
          });
        }

        // orderUpdate (internal note)
        if (query.includes('orderUpdate')) {
          return HttpResponse.json({
            data: { orderUpdate: { order: { id: FIXTURES.order.id }, userErrors: [] } },
          });
        }

        return HttpResponse.json({ data: {} });
      }),
    );

    // ── Step 1: Submit cancel request via standalone form ──
    const { csrfToken, cookieHeader } = await getCsrfToken();

    const submitRes = await request(app)
      .post('/proxy/request')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .set('Cookie', cookieHeader)
      .send(`email=customer@example.com&orderNumber=1001&_csrf=${csrfToken}`);

    expect(submitRes.status).toBe(200);
    expect(submitRes.type).toMatch(/html/);

    // Verify email was sent with a confirmation URL
    const token = extractTokenFromEmail();
    expect(token).toBeTruthy();

    // ── Step 2: Confirm cancellation via token ──
    const confirmRes = await request(app).get(`/confirm?token=${encodeURIComponent(token)}`);

    expect(confirmRes.status).toBe(200);
    expect(confirmRes.type).toMatch(/html/);
    // Success page should be returned
    expect(confirmRes.text).toBeTruthy();

    // ── Step 3: Verify DB state ──
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const record = storage.findRequestByTokenHash(tokenHash);

    expect(record).toBeTruthy();
    expect(record.status).toBe('cancel_submitted');
    expect(record.usedAt).toBeTruthy();
    expect(record.refundStatus).toBe('auto_refunded');
  });
});

describe('E2E: Full Confirmation Happy Path (manual-refund / pending approval)', () => {
  it('creates request → confirms via token → cancels order without refund → queues for admin', async () => {
    // Disable auto-refund so the manual approval path is used
    storage.setSetting('auto_refund', 'false');

    // Use a different order ID to avoid duplicate-request check from previous test
    const manualOrder = {
      ...FIXTURES.order,
      id: 'gid://shopify/Order/2002',
      name: '#2002',
    };

    mockServer.use(
      http.post(graphqlUrl, async ({ request: req }) => {
        const body = await req.json();
        const query = body.query || '';

        if (query.includes('orders(first:') || query.includes('orders(query:')) {
          return HttpResponse.json({
            data: { orders: { edges: [{ node: manualOrder }] } },
          });
        }

        if (query.includes('order(id:') || query.includes('node(id:')) {
          return HttpResponse.json({
            data: { order: manualOrder },
          });
        }

        if (query.includes('orderCancel')) {
          return HttpResponse.json({
            data: {
              orderCancel: {
                job: FIXTURES.cancelJob,
                orderCancelUserErrors: [],
              },
            },
          });
        }

        if (query.includes('tagsAdd')) {
          return HttpResponse.json({
            data: { tagsAdd: { node: { id: manualOrder.id }, userErrors: [] } },
          });
        }

        if (query.includes('orderUpdate')) {
          return HttpResponse.json({
            data: { orderUpdate: { order: { id: manualOrder.id }, userErrors: [] } },
          });
        }

        return HttpResponse.json({ data: {} });
      }),
    );

    // ── Step 1: Submit cancel request ──
    const { csrfToken, cookieHeader } = await getCsrfToken();

    const submitRes = await request(app)
      .post('/proxy/request')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .set('Cookie', cookieHeader)
      .send(`email=customer@example.com&orderNumber=2002&_csrf=${csrfToken}`);

    expect(submitRes.status).toBe(200);

    const token = extractTokenFromEmail();
    expect(token).toBeTruthy();

    // ── Step 2: Confirm cancellation ──
    const confirmRes = await request(app).get(`/confirm?token=${encodeURIComponent(token)}`);

    expect(confirmRes.status).toBe(200);
    expect(confirmRes.type).toMatch(/html/);

    // ── Step 3: Verify DB state — should be pending admin approval ──
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const record = storage.findRequestByTokenHash(tokenHash);

    expect(record).toBeTruthy();
    expect(record.status).toBe('cancel_submitted');
    expect(record.usedAt).toBeTruthy();
    expect(record.refundStatus).toBe('pending_approval');
  });
});

describe('E2E: Confirmation edge cases', () => {
  it('rejects double-use of the same confirmation token', async () => {
    // The token from the first test suite was already used
    // Try to use it again — should fail
    storage.setSetting('auto_refund', 'true');

    // Re-submit to get a fresh token
    mockServer.use(
      http.post(graphqlUrl, async ({ request: req }) => {
        const body = await req.json();
        const query = body.query || '';

        if (query.includes('orders(first:') || query.includes('orders(query:')) {
          const freshOrder = {
            ...FIXTURES.order,
            id: 'gid://shopify/Order/3003',
            name: '#3003',
          };
          return HttpResponse.json({
            data: { orders: { edges: [{ node: freshOrder }] } },
          });
        }

        if (query.includes('order(id:') || query.includes('node(id:')) {
          const freshOrder = {
            ...FIXTURES.order,
            id: 'gid://shopify/Order/3003',
            name: '#3003',
          };
          return HttpResponse.json({ data: { order: freshOrder } });
        }

        if (query.includes('orderCancel')) {
          return HttpResponse.json({
            data: { orderCancel: { job: FIXTURES.cancelJob, orderCancelUserErrors: [] } },
          });
        }

        if (query.includes('tagsAdd') || query.includes('orderUpdate')) {
          return HttpResponse.json({ data: { tagsAdd: { node: { id: 'gid://shopify/Order/3003' }, userErrors: [] } } });
        }

        return HttpResponse.json({ data: {} });
      }),
    );

    const { csrfToken, cookieHeader } = await getCsrfToken();
    await request(app)
      .post('/proxy/request')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .set('Cookie', cookieHeader)
      .send(`email=customer@example.com&orderNumber=3003&_csrf=${csrfToken}`);

    const token = extractTokenFromEmail();

    // First use — should succeed
    const firstConfirm = await request(app).get(`/confirm?token=${encodeURIComponent(token)}`);
    expect(firstConfirm.status).toBe(200);

    // Second use — should be rejected
    const secondConfirm = await request(app).get(`/confirm?token=${encodeURIComponent(token)}`);
    expect(secondConfirm.status).toBe(400);
    expect(secondConfirm.text).toContain('already been used');
  });
});
