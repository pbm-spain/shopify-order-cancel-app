import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import crypto from 'crypto';
import request from 'supertest';
import { http, HttpResponse } from 'msw';
import { createMockShopifyServer, generateWebhookHmac, FIXTURES } from './helpers.js';

const testDataDir = `/tmp/shopify-test-refund-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
process.env.DATA_DIR = testDataDir;

// Mock email
vi.mock('../src/email.js', () => ({
  sendConfirmationEmail: vi.fn().mockResolvedValue({ messageId: 'test-msg-id' }),
}));

const mockServer = createMockShopifyServer();

let app;
let storage;

const graphqlUrl = `https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/${process.env.SHOPIFY_ADMIN_API_VERSION}/graphql.json`;

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

function decodeLocation(res) {
  return decodeURIComponent(res.headers.location || '');
}

function createTestRequest(overrides = {}) {
  const id = crypto.randomUUID();
  const tokenHash = crypto.createHash('sha256').update(crypto.randomBytes(32)).digest('hex');
  const now = new Date().toISOString();

  const record = {
    id,
    tokenHash,
    shopDomain: 'test-store.myshopify.com',
    orderId: 'gid://shopify/Order/1001',
    orderNumber: '#1001',
    email: 'customer@example.com',
    status: 'cancel_submitted',
    expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    createdAt: now,
    updatedAt: now,
    usedAt: now,
    cancelledAt: now,
    ipAddress: '127.0.0.1',
    ...overrides,
  };

  storage.saveRequest(record);
  return record;
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

describe('Refund Approve Flow', () => {
  it('rejects approve without authentication', async () => {
    const res = await request(app)
      .post('/admin/refund/approve')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send(`id=${crypto.randomUUID()}`);

    expect(res.status).toBe(401);
  });

  it('rejects invalid UUID format', async () => {
    const { cookieHeader, csrfToken } = await getAdminSession();

    const res = await request(app)
      .post('/admin/refund/approve')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .set('Cookie', cookieHeader)
      .send(`id=not-a-uuid&_csrf=${csrfToken}`);

    expect(res.status).toBe(302);
    expect(decodeLocation(res)).toContain('Invalid request ID');
  });

  it('rejects non-existent request', async () => {
    const { cookieHeader, csrfToken } = await getAdminSession();
    const fakeId = crypto.randomUUID();

    const res = await request(app)
      .post('/admin/refund/approve')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .set('Cookie', cookieHeader)
      .send(`id=${fakeId}&_csrf=${csrfToken}`);

    expect(res.status).toBe(302);
    expect(decodeLocation(res)).toContain('Request not found');
  });

  it('rejects approve when refund status is not pending_approval', async () => {
    const record = createTestRequest();

    const { cookieHeader, csrfToken } = await getAdminSession();

    const res = await request(app)
      .post('/admin/refund/approve')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .set('Cookie', cookieHeader)
      .send(`id=${record.id}&_csrf=${csrfToken}`);

    expect(res.status).toBe(302);
    expect(decodeLocation(res)).toContain('already been processed');
  });

  it('approves refund for valid pending request', async () => {
    const record = createTestRequest();
    storage.updateRefundById(record.id, { refundStatus: 'pending_approval' });

    // Override MSW handlers for this test
    mockServer.use(
      http.post(graphqlUrl, async ({ request: req }) => {
        const body = await req.json();
        const query = body.query || '';

        // suggestedRefund query (used by createOrderRefund to calculate amounts)
        if (query.includes('suggestedRefund')) {
          return HttpResponse.json({
            data: {
              order: {
                id: 'gid://shopify/Order/1001',
                name: '#1001',
                suggestedRefund: {
                  amountSet: { shopMoney: { amount: '100.00', currencyCode: 'EUR' } },
                  refundLineItems: [{ lineItem: { id: 'gid://shopify/LineItem/1' }, quantity: 1 }],
                  shipping: { amountSet: { shopMoney: { amount: '0.00', currencyCode: 'EUR' } } },
                },
              },
            },
          });
        }

        // Direct order lookup (for findOrderById — verify cancelled state)
        if (query.includes('order(id:')) {
          return HttpResponse.json({
            data: { order: FIXTURES.cancelledOrder },
          });
        }
        if (query.includes('refundCreate')) {
          return HttpResponse.json({
            data: { refundCreate: { refund: FIXTURES.refund, userErrors: [] } },
          });
        }
        if (query.includes('tagsRemove')) {
          return HttpResponse.json({
            data: { tagsRemove: { node: { id: 'gid://shopify/Order/1001' }, userErrors: [] } },
          });
        }
        if (query.includes('orderUpdate')) {
          return HttpResponse.json({
            data: { orderUpdate: { order: { id: 'gid://shopify/Order/1001' }, userErrors: [] } },
          });
        }
        return HttpResponse.json({ data: {} });
      }),
    );

    const { cookieHeader, csrfToken } = await getAdminSession();

    const res = await request(app)
      .post('/admin/refund/approve')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .set('Cookie', cookieHeader)
      .send(`id=${record.id}&_csrf=${csrfToken}`);

    expect(res.status).toBe(302);
    expect(decodeLocation(res)).toContain('Refund approved');

    const updated = storage.findRequestById(record.id);
    expect(updated.refundStatus).toBe('approved');
    expect(updated.refundedAt).toBeTruthy();
  });
});

describe('Refund Deny Flow', () => {
  it('denies refund for valid pending request', async () => {
    const record = createTestRequest();
    storage.updateRefundById(record.id, { refundStatus: 'pending_approval' });

    // Mock Shopify API for tagsRemove and orderUpdate
    mockServer.use(
      http.post(graphqlUrl, async ({ request: req }) => {
        const body = await req.json();
        const query = body.query || '';

        if (query.includes('tagsRemove')) {
          return HttpResponse.json({
            data: { tagsRemove: { node: { id: 'gid://shopify/Order/1001' }, userErrors: [] } },
          });
        }
        if (query.includes('orderUpdate')) {
          return HttpResponse.json({
            data: { orderUpdate: { order: { id: 'gid://shopify/Order/1001' }, userErrors: [] } },
          });
        }
        return HttpResponse.json({ data: {} });
      }),
    );

    const { cookieHeader, csrfToken } = await getAdminSession();

    const res = await request(app)
      .post('/admin/refund/deny')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .set('Cookie', cookieHeader)
      .send(`id=${record.id}&_csrf=${csrfToken}`);

    expect(res.status).toBe(302);
    expect(decodeLocation(res)).toContain('Refund denied');

    const updated = storage.findRequestById(record.id);
    expect(updated.refundStatus).toBe('denied');
  });

  it('prevents concurrent double-deny (atomic state transition)', async () => {
    const record = createTestRequest();
    storage.updateRefundById(record.id, { refundStatus: 'pending_approval' });

    const success = storage.atomicUpdateRefundById(record.id, 'pending_approval', {
      refundStatus: 'denied',
    });
    expect(success).toBe(true);

    const duplicate = storage.atomicUpdateRefundById(record.id, 'pending_approval', {
      refundStatus: 'denied',
    });
    expect(duplicate).toBe(false);
  });
});

describe('Webhook-driven Refund Sync', () => {
  it('updates refund status when external refund webhook arrives', async () => {
    const record = createTestRequest({
      orderId: 'gid://shopify/Order/2002',
    });
    storage.updateRefundById(record.id, { refundStatus: 'pending_approval' });

    const body = JSON.stringify({ id: 8001, order_id: 2002 });
    const hmac = generateWebhookHmac(body);

    const res = await request(app)
      .post('/webhooks/refunds/create')
      .set('Content-Type', 'application/json')
      .set('X-Shopify-Hmac-SHA256', hmac)
      .set('X-Shopify-Webhook-Id', crypto.randomUUID())
      .send(body);

    expect(res.status).toBe(200);

    const updated = storage.findRequestById(record.id);
    expect(updated.refundStatus).toBe('approved');
    expect(updated.refundedAt).toBeTruthy();
  });
});

describe('Webhook Order Fulfillment Denial', () => {
  it('denies pending request when order is fulfilled', async () => {
    const record = createTestRequest({
      status: 'pending_confirmation',
      usedAt: null,
      cancelledAt: null,
      orderId: 'gid://shopify/Order/3003',
    });

    const body = JSON.stringify({
      id: 3003,
      fulfillment_status: 'fulfilled',
      cancelled_at: null,
    });
    const hmac = generateWebhookHmac(body);

    const res = await request(app)
      .post('/webhooks/orders/updated')
      .set('Content-Type', 'application/json')
      .set('X-Shopify-Hmac-SHA256', hmac)
      .set('X-Shopify-Webhook-Id', crypto.randomUUID())
      .send(body);

    expect(res.status).toBe(200);

    const updated = storage.findRequestById(record.id);
    expect(updated.status).toBe('rejected_order_fulfilled');
    expect(updated.refundStatus).toBe('denied');
  });
});

describe('Admin Settings', () => {
  it('reads current auto-refund setting', async () => {
    const isAuto = storage.isAutoRefundEnabled();
    expect(typeof isAuto).toBe('boolean');
  });

  it('allowed fulfillment statuses defaults include UNFULFILLED', async () => {
    const statuses = storage.getAllowedFulfillmentStatuses();
    expect(statuses).toContain('UNFULFILLED');
  });
});
