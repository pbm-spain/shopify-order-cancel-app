import crypto from 'crypto';
import { config } from './config.js';
import { normalizeEmail, normalizeOrderNumber, isValidOrderNumber } from './utils.js';
import { logger } from './logger.js';
import { getAllowedFulfillmentStatuses, getAllowedFinancialStatuses } from './storage.js';

const endpoint = `https://${config.shopDomain}/admin/api/${config.apiVersion}/graphql.json`;

/**
 * GraphQL request with retry logic and exponential backoff.
 *
 * @param {string} query - GraphQL query/mutation
 * @param {object} variables - GraphQL variables
 * @param {object} options - Additional options (currently unused, kept for compatibility)
 */
async function graphql(query, variables = {}, options = {}) {
  const maxRetries = 3;
  const baseDelay = 1000; // 1 second
  const jitterFactor = 0.1;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    let response = null;

    try {
      const headers = {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': config.adminToken,
      };

      response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({ query, variables }),
        signal: controller.signal,
      });

      const json = await response.json();
      if (!response.ok || json.errors) {
        // Only retry on 5xx errors, not 4xx (Fix #5)
        if (response.status >= 500) {
          // Log error count at error level with codes and fields (Fix #20)
          const errorCount = json.errors?.length ?? 1;
          const errorDetails = json.errors?.map(e => ({
            code: e.code || 'UNKNOWN',
            message: e.message,
            field: e.field,
          })) || [];
          logger.warn('Shopify GraphQL 5xx error (will retry)', {
            status: response.status,
            errorCount,
            errors: errorDetails,
          });
          throw new Error('Shopify API 5xx error');
        }

        // 4xx errors are not retryable
        const errorCount = json.errors?.length ?? 1;
        const errorDetails = json.errors?.map(e => ({
          code: e.code || 'UNKNOWN',
          message: e.message,
          field: e.field,
        })) || [];
        logger.error('Shopify GraphQL error', {
          status: response.status,
          errorCount,
          errors: errorDetails,
        });
        if (process.env.LOG_LEVEL === 'debug') {
          logger.debug('GraphQL error details', { errors: json.errors });
        }
        throw new Error('Shopify API error');
      }
      return json.data;
    } catch (error) {
      const isLastAttempt = attempt === maxRetries;
      const isRetryable = !response || response.status >= 500 || error.name === 'AbortError';

      if (!isRetryable || isLastAttempt) {
        throw error;
      }

      // Calculate exponential backoff with jitter (Fix #5)
      const exponentialDelay = baseDelay * Math.pow(2, attempt);
      const jitter = exponentialDelay * jitterFactor * Math.random();
      const delayMs = exponentialDelay + jitter;

      logger.warn('Shopify API error, retrying', {
        attempt: attempt + 1,
        maxRetries,
        delayMs: Math.round(delayMs),
      });

      await new Promise(resolve => setTimeout(resolve, delayMs));
    } finally {
      clearTimeout(timeout);
    }
  }
}

export async function findOrderByEmailAndName({ email, orderNumber, includeAllStatuses = false }) {
  const normalizedEmail = normalizeEmail(email);
  const normalizedOrderNumber = normalizeOrderNumber(orderNumber);

  // Defense-in-depth: validate order number format even if caller already checked (Fix #9)
  if (!isValidOrderNumber(normalizedOrderNumber)) {
    throw new Error('Invalid order number format.');
  }

  // Fix #23: Use status:open for customer-facing flows, but allow all statuses for admin flows
  // (e.g. admin refund approval needs to find cancelled orders)
  const statusFilter = includeAllStatuses ? '' : ' status:open';
  const search = `name:${JSON.stringify(normalizedOrderNumber)} created_at:>=${lookbackDate()}${statusFilter}`;

  const query = `#graphql
    query FindOrder($search: String!) {
      orders(first: 10, query: $search) {
        edges {
          node {
            id
            name
            email
            cancelledAt
            displayFinancialStatus
            displayFulfillmentStatus
            fulfillmentOrders(first: 10) {
              edges {
                node {
                  id
                  status
                }
              }
            }
            customer {
              id
              email
            }
          }
        }
      }
    }
  `;

  const data = await graphql(query, { search });
  const nodes = data.orders.edges.map((edge) => edge.node);

  const found =
    nodes.find((node) => {
      const orderEmail = normalizeEmail(node.email || node.customer?.email || '');
      return node.name === normalizedOrderNumber && orderEmail === normalizedEmail;
    }) || null;

  logger.info('Order search completed', {
    email: normalizedEmail,
    orderNumber: normalizedOrderNumber,
    found: !!found,
  });

  return found;
}

function lookbackDate() {
  const date = new Date(Date.now() - config.orderLookbackDays * 24 * 60 * 60 * 1000);
  return date.toISOString();
}

/**
 * All possible Shopify fulfillment statuses (displayFulfillmentStatus).
 * Exposed so the admin panel can render checkboxes for each.
 */
export const ALL_FULFILLMENT_STATUSES = [
  { value: 'UNFULFILLED',         label: 'Unfulfilled' },
  { value: 'OPEN',                label: 'Open' },
  { value: 'PARTIALLY_FULFILLED', label: 'Partially Fulfilled' },
  { value: 'FULFILLED',           label: 'Fulfilled / Shipped' },
  { value: 'RESTOCKED',           label: 'Restocked' },
  { value: 'PENDING_FULFILLMENT', label: 'Pending Fulfillment' },
  { value: 'ON_HOLD',             label: 'On Hold' },
  { value: 'REQUEST_DECLINED',    label: 'Request Declined' },
  { value: 'SCHEDULED',           label: 'Scheduled' },
  { value: 'IN_PROGRESS',         label: 'In Progress' },
];

/**
 * All possible Shopify financial statuses (displayFinancialStatus).
 */
export const ALL_FINANCIAL_STATUSES = [
  { value: 'PENDING',             label: 'Pending' },
  { value: 'AUTHORIZED',          label: 'Authorized' },
  { value: 'PAID',                label: 'Paid' },
  { value: 'PARTIALLY_PAID',      label: 'Partially Paid' },
  { value: 'PARTIALLY_REFUNDED',  label: 'Partially Refunded' },
  { value: 'REFUNDED',            label: 'Refunded' },
  { value: 'VOIDED',              label: 'Voided' },
  { value: 'EXPIRED',             label: 'Expired' },
];

/**
 * Check if an order is eligible for cancellation.
 *
 * The allowed fulfillment and financial statuses are read from admin_settings
 * (configurable from the admin panel). This replaces the old hardcoded check.
 */
export function isOrderCancelable(order) {
  if (!order) return { ok: false, reason: 'Order not found.' };
  if (order.cancelledAt) return { ok: false, reason: 'This order has already been cancelled.' };

  // Check fulfillment status against admin-configured allowed list
  const allowedFulfillment = getAllowedFulfillmentStatuses();
  if (!allowedFulfillment.includes(order.displayFulfillmentStatus)) {
    const label = ALL_FULFILLMENT_STATUSES.find((s) => s.value === order.displayFulfillmentStatus)?.label || order.displayFulfillmentStatus;
    return {
      ok: false,
      reason: `The order's fulfillment status (${label}) does not allow cancellation.`,
    };
  }

  // Check financial status against admin-configured allowed list
  const allowedFinancial = getAllowedFinancialStatuses();
  if (order.displayFinancialStatus && !allowedFinancial.includes(order.displayFinancialStatus)) {
    const label = ALL_FINANCIAL_STATUSES.find((s) => s.value === order.displayFinancialStatus)?.label || order.displayFinancialStatus;
    return {
      ok: false,
      reason: `The order's financial status (${label}) does not allow cancellation.`,
    };
  }

  // Check fulfillment orders for in-progress states (Fulfillment Orders API)
  // Fix #40: SUBMITTED is not a valid FulfillmentOrderStatus enum value (2026-01).
  // Valid blocking statuses: IN_PROGRESS (being processed), ON_HOLD (merchant hold),
  // INCOMPLETE (cannot be completed as requested).
  const fulfillmentOrders = order.fulfillmentOrders?.edges?.map((e) => e.node) || [];
  const blockingStatuses = ['IN_PROGRESS', 'ON_HOLD', 'INCOMPLETE'];
  const hasBlockingFulfillmentOrder = fulfillmentOrders.some((fo) =>
    blockingStatuses.includes(fo.status),
  );

  if (hasBlockingFulfillmentOrder) {
    return { ok: false, reason: 'The order has fulfillment orders in progress.' };
  }

  return { ok: true };
}

/**
 * Cancel an order using the Shopify Admin GraphQL API.
 *
 * IMPORTANT: This mutation returns a Job (async operation). The order may NOT be
 * immediately cancelled. The app does NOT poll the job status; instead, it relies on
 * the orders/cancelled webhook to detect when the cancellation completes.
 *
 * Design decision: Polling adds complexity and latency. Webhooks provide real-time
 * notification when the cancellation actually completes on Shopify's side.
 *
 * API notes (March 2026):
 * - Uses `refundMethod` (OrderCancelRefundMethodInput) — replaces deprecated `refund: Boolean`
 * - `notifyCustomer` is optional (Boolean, defaults to false)
 * - `orderCancel` does NOT support the @idempotent directive (only 17 inventory/refund
 *   mutations do as of Feb 2026). The mutation is naturally idempotent because cancelling
 *   an already-cancelled order returns an orderCancelUserError.
 * - `reason` is a required OrderCancelReason enum
 * - `staffNote` max 255 chars
 *
 * @param {string} orderId - Shopify GID
 * @param {string} staffNote - Internal note (max 255 chars)
 * @param {object} opts
 * @param {boolean} opts.withRefund - Whether to issue refund to original payment method
 * @param {string} opts.reason - OrderCancelReason enum (CUSTOMER, DECLINED, FRAUD, INVENTORY, OTHER, STAFF)
 * @returns {object} Job object with {id, done} — order cancellation is async, not immediate
 */
export async function cancelOrder(orderId, staffNote, { withRefund = true, reason = 'CUSTOMER' } = {}) {
  const shouldRefund = withRefund && config.cancelRefund;

  const mutation = `#graphql
    mutation CancelOrder(
      $orderId: ID!,
      $notifyCustomer: Boolean,
      $restock: Boolean!,
      $refundMethod: OrderCancelRefundMethodInput,
      $reason: OrderCancelReason!,
      $staffNote: String
    ) {
      orderCancel(
        orderId: $orderId
        notifyCustomer: $notifyCustomer
        restock: $restock
        refundMethod: $refundMethod
        reason: $reason
        staffNote: $staffNote
      ) {
        job {
          id
          done
        }
        orderCancelUserErrors {
          field
          message
          code
        }
      }
    }
  `;

  const data = await graphql(mutation, {
    orderId,
    notifyCustomer: config.cancelNotifyCustomer,
    restock: config.cancelRestock,
    refundMethod: { originalPaymentMethodsRefund: shouldRefund },
    reason,
    staffNote: staffNote?.slice(0, 255) || null,
  });

  const errors = data.orderCancel.orderCancelUserErrors || [];
  if (errors.length) {
    // If the order is already cancelled, treat as idempotent success (Fix #6)
    const alreadyCancelled = errors.some(
      (e) => e.code === 'ORDER_IS_ALREADY_CANCELLED' || /already.*cancel/i.test(e.message),
    );
    if (alreadyCancelled) {
      logger.info('Order already cancelled (idempotent)', { orderId });
      return data.orderCancel.job;
    }

    const msg = errors.map((e) => e.message).join('; ');
    logger.error('Order cancel failed', { orderId, errors: msg });
    throw new Error(`Failed to cancel order: ${msg}`);
  }

  logger.info('Order cancelled successfully', {
    orderId,
    jobId: data.orderCancel.job?.id,
    withRefund: shouldRefund,
  });

  return data.orderCancel.job;
}

/**
 * Create a refund for a cancelled order (admin-approved refund flow).
 *
 * API notes (March 2026):
 * - Uses GraphQL `@idempotent(key: $idempotencyKey)` directive for idempotency (Fix #1).
 * - Uses `suggestedRefund(suggestFullRefund: true)` to calculate correct amounts.
 * - `shipping.fullRefund: true` refunds full shipping cost.
 *
 * @param {string} orderId - Shopify GID
 * @param {string} staffNote - Refund note
 * @param {string} idempotencyKey - UUID or unique string for idempotency
 */
export async function createOrderRefund(orderId, staffNote, idempotencyKey) {
  // First, get the order's suggestedRefund to calculate refund amounts
  const calcQuery = `#graphql
    query SuggestedRefund($orderId: ID!) {
      order(id: $orderId) {
        id
        name
        suggestedRefund(suggestFullRefund: true) {
          amountSet {
            shopMoney { amount currencyCode }
          }
          refundLineItems {
            lineItem { id }
            quantity
          }
          shipping {
            amountSet {
              shopMoney { amount currencyCode }
            }
          }
        }
      }
    }
  `;

  const calcData = await graphql(calcQuery, { orderId });
  const suggested = calcData.order?.suggestedRefund;

  if (!suggested) {
    throw new Error('Could not calculate suggested refund for this order.');
  }

  // Build refund input from suggested refund
  const refundLineItems = (suggested.refundLineItems || []).map((item) => ({
    lineItemId: item.lineItem.id,
    quantity: item.quantity,
  }));

  // Use GraphQL @idempotent directive with idempotencyKey variable (Fix #1)
  const mutation = `#graphql
    mutation RefundCreate($input: RefundInput!, $idempotencyKey: String!) {
      refundCreate(input: $input) @idempotent(key: $idempotencyKey) {
        refund {
          id
          totalRefundedSet {
            shopMoney { amount currencyCode }
          }
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const key = String(idempotencyKey || crypto.randomUUID());
  const data = await graphql(mutation, {
    input: {
      orderId,
      notify: config.cancelNotifyCustomer,
      note: staffNote || 'Refund approved by admin',
      refundLineItems,
      shipping: {
        fullRefund: true,
      },
    },
    idempotencyKey: key,
  });

  const errors = data.refundCreate.userErrors || [];
  if (errors.length) {
    const msg = errors.map((e) => e.message).join('; ');
    logger.error('Refund creation failed', { orderId, errors: msg });
    throw new Error(`Failed to create refund: ${msg}`);
  }

  const refund = data.refundCreate.refund;
  logger.info('Refund created successfully', {
    orderId,
    refundId: refund?.id,
    amount: refund?.totalRefundedSet?.shopMoney?.amount,
    currency: refund?.totalRefundedSet?.shopMoney?.currencyCode,
  });

  return refund;
}

/**
 * Find an order directly by its GraphQL GID.
 *
 * Fix #30: Use this for admin flows (e.g. refund approval) instead of
 * findOrderByEmailAndName, which applies lookback and status filters that
 * can exclude cancelled or old orders.
 *
 * The `order(id:)` query works without the 60-day default restriction
 * that applies to the `orders(query:)` search endpoint.
 *
 * @param {string} orderId - Shopify GraphQL GID (e.g. "gid://shopify/Order/12345")
 * @returns {object|null} Order object or null if not found
 */
export async function findOrderById(orderId) {
  const query = `#graphql
    query GetOrder($id: ID!) {
      order(id: $id) {
        id
        name
        email
        cancelledAt
        displayFinancialStatus
        displayFulfillmentStatus
        fulfillmentOrders(first: 10) {
          edges {
            node {
              id
              status
            }
          }
        }
        customer {
          id
          email
        }
      }
    }
  `;

  const data = await graphql(query, { id: orderId });
  const order = data.order || null;

  logger.info('Order lookup by ID completed', {
    orderId,
    found: !!order,
  });

  return order;
}

// ═══════════════════════════════════════════════════════════════════════
// ORDER TAGS & NOTES — Used to reflect refund-pending state in Shopify
// ═══════════════════════════════════════════════════════════════════════

/**
 * Add tags to an order.
 * Uses the `tagsAdd` mutation which works with any taggable resource.
 *
 * @param {string} orderId - Shopify GID (e.g. "gid://shopify/Order/123")
 * @param {string[]} tags - Tags to add
 */
export async function addTagsToOrder(orderId, tags) {
  const mutation = `#graphql
    mutation TagsAdd($id: ID!, $tags: [String!]!) {
      tagsAdd(id: $id, tags: $tags) {
        node { id }
        userErrors { field message }
      }
    }
  `;

  const data = await graphql(mutation, { id: orderId, tags });
  const errors = data.tagsAdd.userErrors || [];
  if (errors.length) {
    logger.warn('Failed to add tags to order', { orderId, tags, errors });
  } else {
    logger.info('Tags added to order', { orderId, tags });
  }
}

/**
 * Remove tags from an order.
 *
 * @param {string} orderId - Shopify GID
 * @param {string[]} tags - Tags to remove
 */
export async function removeTagsFromOrder(orderId, tags) {
  const mutation = `#graphql
    mutation TagsRemove($id: ID!, $tags: [String!]!) {
      tagsRemove(id: $id, tags: $tags) {
        node { id }
        userErrors { field message }
      }
    }
  `;

  const data = await graphql(mutation, { id: orderId, tags });
  const errors = data.tagsRemove.userErrors || [];
  if (errors.length) {
    logger.warn('Failed to remove tags from order', { orderId, tags, errors });
  } else {
    logger.info('Tags removed from order', { orderId, tags });
  }
}

/**
 * Update an order's internal note.
 * Uses the `orderUpdate` mutation with the `note` field.
 *
 * @param {string} orderId - Shopify GID
 * @param {string} note - New note content
 */
export async function updateOrderNote(orderId, note) {
  const mutation = `#graphql
    mutation OrderUpdate($input: OrderInput!) {
      orderUpdate(input: $input) {
        order { id note }
        userErrors { field message }
      }
    }
  `;

  const data = await graphql(mutation, {
    input: { id: orderId, note },
  });

  const errors = data.orderUpdate.userErrors || [];
  if (errors.length) {
    logger.warn('Failed to update order note', { orderId, errors });
  } else {
    logger.info('Order note updated', { orderId });
  }
}
