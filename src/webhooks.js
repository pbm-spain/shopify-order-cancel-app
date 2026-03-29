/**
 * Shopify Webhooks Handler
 *
 * Processes webhooks from Shopify:
 * - orders/updated: Sync pending cancellation requests when order status changes
 * - orders/cancelled: Update DB when order is cancelled externally
 * - refunds/create: Update DB when refund is created externally
 *
 * All webhooks are verified using HMAC-SHA256 signature.
 *
 * IMPORTANT: Shopify webhooks deliver REST API payloads, NOT GraphQL payloads.
 * - Order IDs are numeric (e.g. 12345), not GraphQL GIDs (gid://shopify/Order/12345)
 * - Field names use snake_case (e.g. cancelled_at, fulfillment_status)
 * - Fulfillment status values are lowercase (e.g. "fulfilled", not "FULFILLED")
 *
 * The app stores GraphQL GIDs in the database, so webhook handlers must convert
 * numeric IDs to GID format before querying the database.
 */

import crypto from 'crypto';
import { config } from './config.js';
import { logger, auditLog } from './logger.js';
import {
  findRequestByTokenHash,
  updateRequest,
  findPendingRequestForOrder,
  isWebhookProcessed,
  markWebhookProcessed,
  getAllowedFulfillmentStatuses,
} from './storage.js';

/**
 * Convert a numeric Shopify REST order ID to a GraphQL GID.
 * The database stores GraphQL GIDs, but webhooks deliver REST numeric IDs.
 *
 * @param {number|string} numericId - REST API order ID (e.g. 12345)
 * @returns {string} GraphQL GID (e.g. "gid://shopify/Order/12345")
 */
function toOrderGid(numericId) {
  return `gid://shopify/Order/${numericId}`;
}

/**
 * Map REST fulfillment_status values to GraphQL displayFulfillmentStatus values.
 * REST webhook payloads use lowercase snake_case values; our DB stores GraphQL enum values.
 */
const REST_TO_GRAPHQL_FULFILLMENT = {
  null: 'UNFULFILLED',
  unfulfilled: 'UNFULFILLED',
  partial: 'PARTIALLY_FULFILLED',
  fulfilled: 'FULFILLED',
  restocked: 'RESTOCKED',
};

/**
 * Verify Shopify webhook HMAC-SHA256 signature.
 * Returns true if signature is valid, false otherwise.
 */
export function verifyWebhookSignature(req) {
  const secret = config.webhookSecret;
  if (!secret) {
    logger.warn('Webhook signature verification disabled: SHOPIFY_WEBHOOK_SECRET not set', {
      traceId: req.traceId,
    });
    return false;
  }

  const hmacHeader = req.get('X-Shopify-Hmac-SHA256');
  if (!hmacHeader) {
    logger.warn('Missing X-Shopify-Hmac-SHA256 header', { traceId: req.traceId });
    return false;
  }

  // Webhook body must be the raw request body (not parsed JSON)
  const body = req.rawBody;
  if (!body) {
    logger.warn('Missing raw body for webhook signature verification', { traceId: req.traceId });
    return false;
  }

  // Compute HMAC-SHA256 signature
  const computed = crypto
    .createHmac('sha256', secret)
    .update(body, 'utf8')
    .digest('base64');

  // Timing-safe comparison
  const headerBuf = Buffer.from(hmacHeader);
  const computedBuf = Buffer.from(computed);

  const isValid =
    headerBuf.length === computedBuf.length &&
    crypto.timingSafeEqual(headerBuf, computedBuf);

  if (!isValid) {
    logger.warn('Invalid webhook signature', {
      topic: req.get('X-Shopify-Topic'),
      traceId: req.traceId,
    });
  }

  return isValid;
}

/**
 * Handle orders/updated webhook.
 * If an order with a pending cancellation request changes status,
 * update the cancel request status in the database.
 *
 * REST payload fields used:
 * - id: numeric order ID
 * - fulfillment_status: "fulfilled", "partial", null, etc.
 * - cancelled_at: ISO 8601 string or null
 */
export async function handleOrderUpdated(req, res) {
  try {
    const webhookId = req.get('X-Shopify-Webhook-Id');

    // Deduplication: Check if already processed
    if (webhookId && isWebhookProcessed(webhookId)) {
      logger.debug('Webhook already processed, skipping', { webhookId, traceId: req.traceId });
      return res.json({ ok: true });
    }

    // Fix #25: Mark webhook as processed early to prevent duplicate processing on all paths
    if (webhookId) {
      markWebhookProcessed(webhookId);
    }

    const body = JSON.parse(req.rawBody);
    const numericId = body.id;

    if (!numericId) {
      return res.status(400).json({ error: 'Invalid webhook payload' });
    }

    // Convert REST numeric ID to GraphQL GID for database lookup (Fix #21)
    const orderGid = toOrderGid(numericId);

    // Find pending cancel request for this order
    const pending = findPendingRequestForOrder(orderGid);

    if (!pending) {
      logger.debug('Order updated but no pending cancel request', {
        orderId: numericId,
        orderGid,
        traceId: req.traceId,
      });
      return res.json({ ok: true });
    }

    // REST webhook uses snake_case field names (Fix #21)
    const cancelledAt = body.cancelled_at;
    const restFulfillmentStatus = body.fulfillment_status;

    if (cancelledAt) {
      logger.info('Order already cancelled externally', {
        orderId: numericId,
        traceId: req.traceId,
      });
      return res.json({ ok: true });
    }

    // Fix #31: Check admin-configured allowed fulfillment statuses instead of hardcoding
    // Map REST status to GraphQL enum, then check against admin-configured allowed list
    const graphqlStatus = REST_TO_GRAPHQL_FULFILLMENT[restFulfillmentStatus] || (restFulfillmentStatus ? restFulfillmentStatus.toUpperCase() : 'UNFULFILLED');
    const allowedStatuses = getAllowedFulfillmentStatuses();

    if (!allowedStatuses.includes(graphqlStatus)) {
      updateRequest(pending.tokenHash, {
        status: 'rejected_order_fulfilled',
        refundStatus: 'denied',
      });

      auditLog('cancel_denied_order_fulfilled', {
        orderId: numericId,
        orderGid,
        fulfillmentStatus: graphqlStatus,
        restFulfillmentStatus,
        allowedStatuses,
        traceId: req.traceId,
      });

      logger.info('Pending cancel request denied: fulfillment status not in allowed list', {
        orderId: numericId,
        fulfillmentStatus: graphqlStatus,
        restFulfillmentStatus,
        traceId: req.traceId,
      });
    }

    return res.json({ ok: true });
  } catch (error) {
    logger.error('Failed to handle orders/updated webhook', {
      error: error.message,
      traceId: req.traceId,
    });
    // Return 200 OK to prevent Shopify from retrying indefinitely
    return res.json({ ok: false, error: error.message });
  }
}

/**
 * Handle orders/cancelled webhook.
 * If an order is cancelled outside the app, update the DB record.
 *
 * REST payload fields used:
 * - id: numeric order ID
 * - name: order display name (e.g. "#1001")
 * - cancelled_at: ISO 8601 string
 */
export async function handleOrderCancelled(req, res) {
  try {
    const webhookId = req.get('X-Shopify-Webhook-Id');

    // Deduplication: Check if already processed
    if (webhookId && isWebhookProcessed(webhookId)) {
      logger.debug('Webhook already processed, skipping', { webhookId, traceId: req.traceId });
      return res.json({ ok: true });
    }

    // Fix #25: Mark webhook as processed early to prevent duplicate processing on all paths
    if (webhookId) {
      markWebhookProcessed(webhookId);
    }

    const body = JSON.parse(req.rawBody);
    const numericId = body.id;
    const name = body.name;
    // REST uses snake_case (Fix #21)
    const cancelledAt = body.cancelled_at;

    if (!numericId) {
      return res.status(400).json({ error: 'Invalid webhook payload' });
    }

    // Convert REST numeric ID to GraphQL GID for database lookup (Fix #21)
    const orderGid = toOrderGid(numericId);

    // Find pending cancel request for this order
    const pending = findPendingRequestForOrder(orderGid);

    if (!pending) {
      logger.debug('Order cancelled externally (no pending request)', {
        orderId: numericId,
        orderGid,
        orderName: name,
        traceId: req.traceId,
      });
      return res.json({ ok: true });
    }

    // Update the cancel request record
    updateRequest(pending.tokenHash, {
      status: 'cancelled_externally',
      cancelledAt: cancelledAt || new Date().toISOString(),
    });

    auditLog('cancel_detected_external', {
      orderId: numericId,
      orderGid,
      orderName: name,
      traceId: req.traceId,
    });

    logger.info('Order cancelled externally, updated cancel request', {
      orderId: numericId,
      orderGid,
      traceId: req.traceId,
    });

    return res.json({ ok: true });
  } catch (error) {
    logger.error('Failed to handle orders/cancelled webhook', {
      error: error.message,
      traceId: req.traceId,
    });
    return res.json({ ok: false, error: error.message });
  }
}

/**
 * Handle refunds/create webhook.
 * If a refund is created outside the app, update the DB record's refund status.
 *
 * REST payload fields used:
 * - id: numeric refund ID
 * - order_id: numeric order ID (already snake_case in REST)
 */
export async function handleRefundCreated(req, res) {
  try {
    const webhookId = req.get('X-Shopify-Webhook-Id');

    // Deduplication: Check if already processed
    if (webhookId && isWebhookProcessed(webhookId)) {
      logger.debug('Webhook already processed, skipping', { webhookId, traceId: req.traceId });
      return res.json({ ok: true });
    }

    // Fix #25: Mark webhook as processed early to prevent duplicate processing on all paths
    if (webhookId) {
      markWebhookProcessed(webhookId);
    }

    const body = JSON.parse(req.rawBody);
    const { id: refundId, order_id: numericOrderId } = body;

    if (!refundId || !numericOrderId) {
      return res.status(400).json({ error: 'Invalid webhook payload' });
    }

    // Convert REST numeric ID to GraphQL GID for database lookup (Fix #21)
    const orderGid = toOrderGid(numericOrderId);

    // Find pending cancel request for this order
    const pending = findPendingRequestForOrder(orderGid);

    if (!pending) {
      logger.debug('Refund created but no pending cancel request', {
        refundId,
        orderId: numericOrderId,
        orderGid,
        traceId: req.traceId,
      });
      return res.json({ ok: true });
    }

    // Only update if the pending request doesn't already have a refund status
    if (pending.refundStatus === 'none' || pending.refundStatus === 'pending_approval') {
      updateRequest(pending.tokenHash, {
        refundStatus: 'approved',
        refundedAt: new Date().toISOString(),
      });

      auditLog('refund_detected_external', {
        orderId: numericOrderId,
        orderGid,
        refundId,
        traceId: req.traceId,
      });

      logger.info('Refund created externally, updated cancel request', {
        orderId: numericOrderId,
        orderGid,
        refundId,
        traceId: req.traceId,
      });
    }

    return res.json({ ok: true });
  } catch (error) {
    logger.error('Failed to handle refunds/create webhook', {
      error: error.message,
      traceId: req.traceId,
    });
    return res.json({ ok: false, error: error.message });
  }
}
