import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import crypto from 'crypto';
import request from 'supertest';
import { createMockShopifyServer, generateWebhookHmac, FIXTURES } from './helpers.js';

// Isolated DATA_DIR for this test file
const testDataDir = `/tmp/shopify-test-webhook-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
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

describe('Webhook HMAC Verification', () => {
  const webhookSecret = process.env.SHOPIFY_WEBHOOK_SECRET;

  describe('orders/updated', () => {
    it('rejects request without HMAC header', async () => {
      const res = await request(app)
        .post('/webhooks/orders/updated')
        .set('Content-Type', 'application/json')
        .send(JSON.stringify({ id: 1001 }));

      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Invalid signature');
    });

    it('rejects request with invalid HMAC', async () => {
      const body = JSON.stringify({ id: 1001 });
      const res = await request(app)
        .post('/webhooks/orders/updated')
        .set('Content-Type', 'application/json')
        .set('X-Shopify-Hmac-SHA256', 'invalid_hmac_value')
        .send(body);

      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Invalid signature');
    });

    it('rejects HMAC signed with wrong secret', async () => {
      const body = JSON.stringify({ id: 1001 });
      const wrongHmac = generateWebhookHmac(body, 'wrong_secret');
      const res = await request(app)
        .post('/webhooks/orders/updated')
        .set('Content-Type', 'application/json')
        .set('X-Shopify-Hmac-SHA256', wrongHmac)
        .send(body);

      expect(res.status).toBe(401);
    });

    it('accepts request with valid HMAC', async () => {
      const body = JSON.stringify({ id: 1001, fulfillment_status: null });
      const hmac = generateWebhookHmac(body, webhookSecret);
      const res = await request(app)
        .post('/webhooks/orders/updated')
        .set('Content-Type', 'application/json')
        .set('X-Shopify-Hmac-SHA256', hmac)
        .set('X-Shopify-Webhook-Id', crypto.randomUUID())
        .send(body);

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });
  });

  describe('orders/cancelled', () => {
    it('rejects without HMAC header', async () => {
      const res = await request(app)
        .post('/webhooks/orders/cancelled')
        .set('Content-Type', 'application/json')
        .send(JSON.stringify({ id: 1001 }));

      expect(res.status).toBe(401);
    });

    it('accepts valid HMAC', async () => {
      const body = JSON.stringify({ id: 1001, name: '#1001', cancelled_at: '2026-01-15T10:00:00Z' });
      const hmac = generateWebhookHmac(body, webhookSecret);
      const res = await request(app)
        .post('/webhooks/orders/cancelled')
        .set('Content-Type', 'application/json')
        .set('X-Shopify-Hmac-SHA256', hmac)
        .set('X-Shopify-Webhook-Id', crypto.randomUUID())
        .send(body);

      expect(res.status).toBe(200);
    });
  });

  describe('refunds/create', () => {
    it('rejects without HMAC header', async () => {
      const res = await request(app)
        .post('/webhooks/refunds/create')
        .set('Content-Type', 'application/json')
        .send(JSON.stringify({ id: 5001, order_id: 1001 }));

      expect(res.status).toBe(401);
    });

    it('accepts valid HMAC', async () => {
      const body = JSON.stringify({ id: 5001, order_id: 1001 });
      const hmac = generateWebhookHmac(body, webhookSecret);
      const res = await request(app)
        .post('/webhooks/refunds/create')
        .set('Content-Type', 'application/json')
        .set('X-Shopify-Hmac-SHA256', hmac)
        .set('X-Shopify-Webhook-Id', crypto.randomUUID())
        .send(body);

      expect(res.status).toBe(200);
    });
  });

  describe('HMAC timing safety', () => {
    it('rejects HMACs of different lengths', async () => {
      const body = JSON.stringify({ id: 1001 });
      const res = await request(app)
        .post('/webhooks/orders/updated')
        .set('Content-Type', 'application/json')
        .set('X-Shopify-Hmac-SHA256', 'short')
        .send(body);

      expect(res.status).toBe(401);
    });
  });

  describe('Webhook deduplication', () => {
    it('processes same webhook ID only once', async () => {
      const webhookId = crypto.randomUUID();
      const body = JSON.stringify({ id: 1001, fulfillment_status: null });
      const hmac = generateWebhookHmac(body, webhookSecret);

      // First request
      const res1 = await request(app)
        .post('/webhooks/orders/updated')
        .set('Content-Type', 'application/json')
        .set('X-Shopify-Hmac-SHA256', hmac)
        .set('X-Shopify-Webhook-Id', webhookId)
        .send(body);

      expect(res1.status).toBe(200);

      // Second request with same webhook ID — should be deduplicated
      const res2 = await request(app)
        .post('/webhooks/orders/updated')
        .set('Content-Type', 'application/json')
        .set('X-Shopify-Hmac-SHA256', hmac)
        .set('X-Shopify-Webhook-Id', webhookId)
        .send(body);

      expect(res2.status).toBe(200);
      expect(res2.body.ok).toBe(true);
    });
  });
});
