/**
 * SQLite-backed storage for cancel requests.
 *
 * Replaces the JSON file-based storage with a proper database that supports:
 * - Concurrent reads/writes (WAL mode)
 * - Atomic operations
 * - Indexed lookups
 * - No data corruption on crash
 *
 * Uses better-sqlite3 for synchronous, fast, zero-config SQLite.
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { logger } from './logger.js';

const dataDir = process.env.DATA_DIR || path.join(process.cwd(), 'data');
try {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
} catch (error) {
  throw new Error(`Failed to create data directory at ${dataDir}: ${error.message}`);
}

const db = new Database(path.join(dataDir, 'cancel-requests.db'));

// Enable WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
// Add busy timeout to handle concurrent access (Fix #11)
db.pragma('busy_timeout = 5000');

// Create tables if not exist
db.exec(`
  CREATE TABLE IF NOT EXISTS cancel_requests (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    shop_domain TEXT NOT NULL,
    order_id TEXT NOT NULL,
    order_number TEXT NOT NULL,
    email TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending_confirmation',
    refund_status TEXT NOT NULL DEFAULT 'none' CHECK (refund_status IN ('none', 'pending_approval', 'approved', 'denied', 'auto_refunded', 'error')),
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    used_at TEXT,
    cancelled_at TEXT,
    cancel_job_id TEXT,
    refunded_at TEXT,
    ip_address TEXT,
    email_sent INTEGER DEFAULT 0,
    email_attempts INTEGER DEFAULT 0,
    last_email_attempt_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_token_hash ON cancel_requests(token_hash);
  CREATE INDEX IF NOT EXISTS idx_order_id ON cancel_requests(order_id);
  CREATE INDEX IF NOT EXISTS idx_email ON cancel_requests(email);
  CREATE INDEX IF NOT EXISTS idx_status ON cancel_requests(status);
  CREATE INDEX IF NOT EXISTS idx_refund_status ON cancel_requests(refund_status);
  CREATE INDEX IF NOT EXISTS idx_created_at ON cancel_requests(created_at DESC);

  -- Admin settings (key-value store)
  CREATE TABLE IF NOT EXISTS admin_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  -- Webhook event deduplication (Fix #11)
  CREATE TABLE IF NOT EXISTS webhook_events (
    webhook_id TEXT PRIMARY KEY,
    received_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_webhook_received_at ON webhook_events(received_at);
`);

// Ensure default admin settings exist
const upsertSettingStmt = db.prepare(`
  INSERT INTO admin_settings (key, value, updated_at)
  VALUES (@key, @value, @updatedAt)
  ON CONFLICT(key) DO NOTHING
`);

const now = new Date().toISOString();
upsertSettingStmt.run({ key: 'auto_refund', value: 'true', updatedAt: now });
upsertSettingStmt.run({
  key: 'allowed_fulfillment_statuses',
  value: JSON.stringify(['UNFULFILLED']),
  updatedAt: now,
});
upsertSettingStmt.run({
  key: 'allowed_financial_statuses',
  value: JSON.stringify(['PENDING', 'AUTHORIZED', 'PAID']),
  updatedAt: now,
});

const insertStmt = db.prepare(`
  INSERT INTO cancel_requests
    (id, token_hash, shop_domain, order_id, order_number, email, status, expires_at, created_at, updated_at, used_at, cancelled_at, cancel_job_id, ip_address, email_sent, email_attempts)
  VALUES
    (@id, @tokenHash, @shopDomain, @orderId, @orderNumber, @email, @status, @expiresAt, @createdAt, @updatedAt, @usedAt, @cancelledAt, @cancelJobId, @ipAddress, @emailSent, @emailAttempts)
`);

const findByTokenHashStmt = db.prepare(`
  SELECT * FROM cancel_requests WHERE token_hash = ?
`);

const updateStmt = db.prepare(`
  UPDATE cancel_requests
  SET status = COALESCE(@status, status),
      refund_status = COALESCE(@refundStatus, refund_status),
      used_at = COALESCE(@usedAt, used_at),
      cancelled_at = COALESCE(@cancelledAt, cancelled_at),
      cancel_job_id = COALESCE(@cancelJobId, cancel_job_id),
      refunded_at = COALESCE(@refundedAt, refunded_at),
      updated_at = @updatedAt
  WHERE token_hash = @tokenHash
`);

// Atomic UPDATE for marking token as used (Fix #4: race condition prevention)
// Only updates if usedAt is NULL, preventing TOCTTOU race on token reuse
const markTokenUsedStmt = db.prepare(`
  UPDATE cancel_requests
  SET used_at = @usedAt,
      status = @status,
      cancelled_at = @cancelledAt,
      cancel_job_id = @cancelJobId,
      refund_status = @refundStatus,
      updated_at = @updatedAt
  WHERE token_hash = @tokenHash AND used_at IS NULL
`);

const countRecentByIpStmt = db.prepare(`
  SELECT COUNT(*) as cnt FROM cancel_requests
  WHERE ip_address = ? AND created_at > ?
`);

function rowToRecord(row) {
  if (!row) return null;
  return {
    id: row.id,
    tokenHash: row.token_hash,
    shopDomain: row.shop_domain,
    orderId: row.order_id,
    orderNumber: row.order_number,
    email: row.email,
    status: row.status,
    refundStatus: row.refund_status,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    usedAt: row.used_at,
    cancelledAt: row.cancelled_at,
    cancelJobId: row.cancel_job_id,
    refundedAt: row.refunded_at,
    ipAddress: row.ip_address,
    emailSent: row.email_sent,
    emailAttempts: row.email_attempts,
    lastEmailAttemptAt: row.last_email_attempt_at,
  };
}

export function saveRequest(record) {
  insertStmt.run({
    id: record.id,
    tokenHash: record.tokenHash,
    shopDomain: record.shopDomain,
    orderId: record.orderId,
    orderNumber: record.orderNumber,
    email: record.email,
    status: record.status,
    expiresAt: record.expiresAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    usedAt: record.usedAt || null,
    cancelledAt: record.cancelledAt || null,
    cancelJobId: record.cancelJobId || null,
    ipAddress: record.ipAddress || null,
    emailSent: record.emailSent || 0,
    emailAttempts: record.emailAttempts || 0,
  });
  return record;
}

export function findRequestByTokenHash(tokenHash) {
  const row = findByTokenHashStmt.get(tokenHash);
  return rowToRecord(row);
}

export function updateRequest(tokenHash, patch) {
  const result = updateStmt.run({
    tokenHash,
    status: patch.status || null,
    refundStatus: patch.refundStatus || null,
    usedAt: patch.usedAt || null,
    cancelledAt: patch.cancelledAt || null,
    cancelJobId: patch.cancelJobId || null,
    refundedAt: patch.refundedAt || null,
    updatedAt: new Date().toISOString(),
  });
  if (result.changes === 0) return null;
  return findRequestByTokenHash(tokenHash);
}

/**
 * Atomic mark token as used (Fix #4: TOCTTOU prevention).
 * Only succeeds if the token hasn't been used yet (used_at IS NULL).
 * Returns true if updated (token was available), false if already used or expired.
 */
export function markTokenAsUsed(tokenHash, status, cancelledAt, cancelJobId, refundStatus) {
  const result = markTokenUsedStmt.run({
    tokenHash,
    usedAt: new Date().toISOString(),
    status,
    cancelledAt,
    cancelJobId,
    refundStatus,
    updatedAt: new Date().toISOString(),
  });
  return result.changes === 1;
}

/**
 * Count recent requests from a given IP (for abuse detection).
 */
export function countRecentRequestsByIp(ip, sinceMinutes = 60) {
  const since = new Date(Date.now() - sinceMinutes * 60 * 1000).toISOString();
  const row = countRecentByIpStmt.get(ip, since);
  return row?.cnt || 0;
}

/**
 * Check for any active (non-terminal) request for this order.
 * Covers both pending_confirmation and cancel_submitted to prevent
 * multiple tokens for the same order (Fix #10).
 */
const findPendingByOrderStmt = db.prepare(`
  SELECT * FROM cancel_requests
  WHERE order_id = ?
    AND status IN ('pending_confirmation', 'cancel_submitted')
    AND (status != 'pending_confirmation' OR expires_at > ?)
  LIMIT 1
`);

export function findPendingRequestForOrder(orderId) {
  return rowToRecord(findPendingByOrderStmt.get(orderId, new Date().toISOString()));
}

// ─── Admin settings ──────────────────────────────────────────────────

const getSettingStmt = db.prepare(`SELECT value FROM admin_settings WHERE key = ?`);
const setSettingStmt = db.prepare(`
  INSERT INTO admin_settings (key, value, updated_at)
  VALUES (@key, @value, @updatedAt)
  ON CONFLICT(key) DO UPDATE SET value = @value, updated_at = @updatedAt
`);

export function getSetting(key) {
  const row = getSettingStmt.get(key);
  return row?.value ?? null;
}

export function setSetting(key, value) {
  setSettingStmt.run({ key, value: String(value), updatedAt: new Date().toISOString() });
}

/**
 * Atomic update of a setting using a database transaction (Fix #13).
 * Ensures that the setting update is atomic and prevents partial updates.
 */
export function setSettingAtomic(key, value) {
  const transaction = db.transaction(() => {
    setSetting(key, value);
  });
  transaction();
}

export function isAutoRefundEnabled() {
  return getSetting('auto_refund') === 'true';
}

export function getAllowedFulfillmentStatuses() {
  try { return JSON.parse(getSetting('allowed_fulfillment_statuses') || '[]'); }
  catch (e) { logger.warn('Failed to parse allowed_fulfillment_statuses, using defaults', { error: e.message }); return ['UNFULFILLED']; }
}

export function getAllowedFinancialStatuses() {
  try { return JSON.parse(getSetting('allowed_financial_statuses') || '[]'); }
  catch (e) { logger.warn('Failed to parse allowed_financial_statuses, using defaults', { error: e.message }); return ['PENDING', 'AUTHORIZED', 'PAID']; }
}

// ─── Pending refund queries ──────────────────────────────────────────

const findPendingRefundsStmt = db.prepare(`
  SELECT * FROM cancel_requests
  WHERE refund_status = 'pending_approval'
  ORDER BY cancelled_at DESC
`);

export function findPendingRefunds() {
  return findPendingRefundsStmt.all().map(rowToRecord);
}

const findRequestByIdStmt = db.prepare(`SELECT * FROM cancel_requests WHERE id = ?`);

export function findRequestById(id) {
  return rowToRecord(findRequestByIdStmt.get(id));
}

const updateRefundByIdStmt = db.prepare(`
  UPDATE cancel_requests
  SET refund_status = @refundStatus,
      refunded_at = @refundedAt,
      updated_at = @updatedAt
  WHERE id = @id
`);

export function updateRefundById(id, patch) {
  updateRefundByIdStmt.run({
    id,
    refundStatus: patch.refundStatus,
    refundedAt: patch.refundedAt || null,
    updatedAt: new Date().toISOString(),
  });
}

// ─── Recent cancellations (for admin dashboard) ─────────────────────

const recentCancellationsStmt = db.prepare(`
  SELECT * FROM cancel_requests
  WHERE status IN ('cancel_submitted', 'cancelled')
  ORDER BY cancelled_at DESC
  LIMIT 50
`);

export function getRecentCancellations() {
  return recentCancellationsStmt.all().map(rowToRecord);
}

// ─── Pagination helpers ──────────────────────────────────────────────

const countPendingRefundsStmt = db.prepare(`
  SELECT COUNT(*) as cnt FROM cancel_requests
  WHERE refund_status = 'pending_approval'
`);

// Fix #45: Add id tiebreaker for stable pagination when timestamps match
const getPendingRefundsPaginatedStmt = db.prepare(`
  SELECT * FROM cancel_requests
  WHERE refund_status = 'pending_approval'
  ORDER BY cancelled_at DESC, id ASC
  LIMIT ? OFFSET ?
`);

export function getPendingRefundsPaginated(page = 1, pageSize = 25) {
  const offset = (page - 1) * pageSize;
  const total = countPendingRefundsStmt.get().cnt || 0;
  const data = getPendingRefundsPaginatedStmt.all(pageSize, offset).map(rowToRecord);
  const totalPages = Math.ceil(total / pageSize);

  return { data, total, page, pageSize, totalPages };
}

const countRecentCancellationsStmt = db.prepare(`
  SELECT COUNT(*) as cnt FROM cancel_requests
  WHERE status IN ('cancel_submitted', 'cancelled')
`);

// Fix #45: Add id tiebreaker for stable pagination when timestamps match
const getRecentCancellationsPaginatedStmt = db.prepare(`
  SELECT * FROM cancel_requests
  WHERE status IN ('cancel_submitted', 'cancelled')
  ORDER BY cancelled_at DESC, id ASC
  LIMIT ? OFFSET ?
`);

export function getRecentCancellationsPaginated(page = 1, pageSize = 25) {
  const offset = (page - 1) * pageSize;
  const total = countRecentCancellationsStmt.get().cnt || 0;
  const data = getRecentCancellationsPaginatedStmt.all(pageSize, offset).map(rowToRecord);
  const totalPages = Math.ceil(total / pageSize);

  return { data, total, page, pageSize, totalPages };
}

// ─── Email retry queue ───────────────────────────────────────────────

// Fix #32: Only retry emails for requests still in pending_confirmation state
// Avoids sending confirmation emails for expired/rejected requests
const getUnsentEmailsStmt = db.prepare(`
  SELECT * FROM cancel_requests
  WHERE email_sent = 0 AND email_attempts < 5 AND status = 'pending_confirmation'
  ORDER BY created_at ASC
`);

export function getUnsentEmails() {
  return getUnsentEmailsStmt.all().map(rowToRecord);
}

const markEmailSentStmt = db.prepare(`
  UPDATE cancel_requests
  SET email_sent = 1, updated_at = @updatedAt
  WHERE id = @id
`);

export function markEmailSent(id) {
  markEmailSentStmt.run({ id, updatedAt: new Date().toISOString() });
}

const incrementEmailAttemptStmt = db.prepare(`
  UPDATE cancel_requests
  SET email_attempts = email_attempts + 1,
      last_email_attempt_at = @lastAttemptAt,
      updated_at = @updatedAt
  WHERE id = @id
`);

export function incrementEmailAttempt(id) {
  const now = new Date().toISOString();
  incrementEmailAttemptStmt.run({ id, lastAttemptAt: now, updatedAt: now });
}

const updateTokenHashStmt = db.prepare(`
  UPDATE cancel_requests
  SET token_hash = @tokenHash, expires_at = @expiresAt, updated_at = @updatedAt
  WHERE id = @id
`);

/**
 * Update the token hash and expiry for email retries (Fix #5).
 * Generates a new token on retry so customers get a fresh confirmation link.
 */
export function updateTokenHash(id, newTokenHash, newExpiresAt) {
  updateTokenHashStmt.run({
    id,
    tokenHash: newTokenHash,
    expiresAt: newExpiresAt,
    updatedAt: new Date().toISOString(),
  });
}

// Fix #26: Filter by email_sent = 0 to exclude emails that eventually succeeded
const getFailedEmailsStmt = db.prepare(`
  SELECT * FROM cancel_requests
  WHERE email_attempts >= ? AND email_sent = 0
  ORDER BY created_at ASC
`);

export function getFailedEmails(maxAttempts = 5) {
  return getFailedEmailsStmt.all(maxAttempts).map(rowToRecord);
}

/**
 * Webhook deduplication (Fix #11)
 * Check if a webhook has already been processed.
 */
const checkWebhookEventStmt = db.prepare(`
  SELECT 1 FROM webhook_events WHERE webhook_id = ?
`);

const insertWebhookEventStmt = db.prepare(`
  INSERT INTO webhook_events (webhook_id, received_at)
  VALUES (@webhookId, @receivedAt)
  ON CONFLICT(webhook_id) DO NOTHING
`);

/**
 * Check if webhook has been processed.
 * Returns true if already processed, false if new.
 */
export function isWebhookProcessed(webhookId) {
  return checkWebhookEventStmt.get(webhookId) !== undefined;
}

/**
 * Mark webhook as processed.
 */
export function markWebhookProcessed(webhookId) {
  insertWebhookEventStmt.run({
    webhookId,
    receivedAt: new Date().toISOString(),
  });
}

/**
 * Clean up webhook events older than the specified number of days (Fix #12).
 * Call this periodically to prevent the webhook_events table from growing unbounded.
 */
export function cleanupOldWebhookEvents(olderThanDays = 30) {
  const cutoffDate = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000).toISOString();
  const stmt = db.prepare('DELETE FROM webhook_events WHERE received_at < ?');
  const result = stmt.run(cutoffDate);
  logger.info('Webhook event cleanup completed', {
    deletedCount: result.changes,
    olderThanDays,
  });
  return result;
}

/**
 * Get database connection reference (for health checks).
 */
export function getDb() {
  return db;
}

/**
 * Graceful shutdown
 */
export function closeDb() {
  // Optimize before close (Fix #16)
  try {
    db.exec('PRAGMA optimize;');
  } catch (e) {
    logger.warn('Failed to optimize database before close', { error: e.message });
  }
  db.close();
}
