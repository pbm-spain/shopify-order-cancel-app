/**
 * Test helpers: HMAC generation, fixtures, and common utilities.
 */

import crypto from 'crypto';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';

// ─── HMAC helpers ────────────────────────────────────────────────────

/**
 * Generate a valid Shopify webhook HMAC-SHA256 signature.
 */
export function generateWebhookHmac(body, secret = process.env.SHOPIFY_WEBHOOK_SECRET) {
  return crypto
    .createHmac('sha256', secret)
    .update(body, 'utf8')
    .digest('base64');
}

/**
 * Generate a valid Shopify App Proxy signature.
 */
export function generateAppProxySignature(params, secret = process.env.SHOPIFY_APP_PROXY_SHARED_SECRET) {
  const message = Object.entries(params)
    .filter(([key]) => key !== 'signature')
    .map(([key, value]) => {
      const v = Array.isArray(value) ? value.join(',') : value;
      return `${key}=${v}`;
    })
    .sort()
    .join('');

  return crypto
    .createHmac('sha256', secret)
    .update(message)
    .digest('hex');
}

// ─── Shopify GraphQL mock fixtures ──────────────────────────────────

export const FIXTURES = {
  order: {
    id: 'gid://shopify/Order/1001',
    name: '#1001',
    email: 'customer@example.com',
    cancelledAt: null,
    displayFulfillmentStatus: 'UNFULFILLED',
    displayFinancialStatus: 'PAID',
    fulfillmentOrders: {
      edges: [],
    },
    customer: {
      id: 'gid://shopify/Customer/1',
      email: 'customer@example.com',
    },
  },

  cancelledOrder: {
    id: 'gid://shopify/Order/1001',
    name: '#1001',
    email: 'customer@example.com',
    cancelledAt: '2026-01-15T10:00:00Z',
    displayFulfillmentStatus: 'UNFULFILLED',
    displayFinancialStatus: 'REFUNDED',
    fulfillmentOrders: {
      edges: [],
    },
  },

  fulfilledOrder: {
    id: 'gid://shopify/Order/1001',
    name: '#1001',
    email: 'customer@example.com',
    cancelledAt: null,
    displayFulfillmentStatus: 'FULFILLED',
    displayFinancialStatus: 'PAID',
    fulfillmentOrders: {
      edges: [],
    },
  },

  cancelJob: {
    id: 'gid://shopify/Job/abc123',
  },

  refund: {
    id: 'gid://shopify/Refund/5001',
  },
};

// ─── MSW Shopify GraphQL handler ────────────────────────────────────

/**
 * Create a MSW server with Shopify Admin API GraphQL handlers.
 * Pass operation-specific overrides to control responses per test.
 */
export function createMockShopifyServer(handlers = {}) {
  const shopifyDomain = process.env.SHOPIFY_STORE_DOMAIN;
  const apiVersion = process.env.SHOPIFY_ADMIN_API_VERSION;
  const graphqlUrl = `https://${shopifyDomain}/admin/api/${apiVersion}/graphql.json`;

  const defaultHandler = http.post(graphqlUrl, async ({ request }) => {
    const body = await request.json();
    const query = body.query || '';

    // Detect operation by query content
    if (query.includes('orders(first:') || query.includes('orders(query:')) {
      const fn = handlers.findOrder || (() => ({
        data: {
          orders: {
            edges: [{ node: FIXTURES.order }],
          },
        },
      }));
      return HttpResponse.json(fn(body));
    }

    if (query.includes('order(id:') || query.includes('node(id:')) {
      const fn = handlers.findOrderById || (() => ({
        data: {
          order: FIXTURES.order,
        },
      }));
      return HttpResponse.json(fn(body));
    }

    if (query.includes('orderCancel')) {
      const fn = handlers.cancelOrder || (() => ({
        data: {
          orderCancel: {
            job: FIXTURES.cancelJob,
            orderCancelUserErrors: [],
          },
        },
      }));
      return HttpResponse.json(fn(body));
    }

    if (query.includes('refundCreate')) {
      const fn = handlers.createRefund || (() => ({
        data: {
          refundCreate: {
            refund: FIXTURES.refund,
            userErrors: [],
          },
        },
      }));
      return HttpResponse.json(fn(body));
    }

    if (query.includes('tagsAdd')) {
      return HttpResponse.json({
        data: { tagsAdd: { node: { id: 'gid://shopify/Order/1001' }, userErrors: [] } },
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

    // Fallback — unknown operation
    return HttpResponse.json({ data: {}, errors: [{ message: 'Unhandled mock operation' }] }, { status: 200 });
  });

  const server = setupServer(defaultHandler);
  return server;
}

// ─── SMTP mock (noop transport) ─────────────────────────────────────

