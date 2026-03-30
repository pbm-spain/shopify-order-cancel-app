import app from './app.js';
import { config } from './config.js';
import { logger } from './logger.js';
import { startEmailQueue, stopEmailQueue } from './emailQueue.js';
import { startSessionCleanup, stopSessionCleanup } from './adminAuth.js';
import { cleanupOldWebhookEvents, closeDb, findStaleCancellations, updateRequest, cleanupOldWebhookProcessingLogs } from './storage.js';
import { setupGlobalErrorHandlers } from './errorHandler.js';

// ─── Global error handlers ──────────────────────────────────────────

setupGlobalErrorHandlers();

// ─── Start background workers ────────────────────────────────────────

startEmailQueue();

// Webhook cleanup: run on startup and every 24 hours
try {
  cleanupOldWebhookEvents(30);
} catch (error) {
  logger.warn('Initial webhook cleanup failed', { error: error.message });
}

const webhookCleanupInterval = setInterval(() => {
  try {
    cleanupOldWebhookEvents(30);
  } catch (error) {
    logger.error('Scheduled webhook cleanup failed', { error: error.message });
  }
}, 24 * 60 * 60 * 1000);
webhookCleanupInterval.unref();

startSessionCleanup();

// Webhook processing log cleanup: run on startup and every 24 hours
try {
  cleanupOldWebhookProcessingLogs(30);
} catch (error) {
  logger.warn('Initial webhook processing log cleanup failed', { error: error.message });
}

const webhookLogCleanupInterval = setInterval(() => {
  try {
    cleanupOldWebhookProcessingLogs(30);
  } catch (error) {
    logger.error('Scheduled webhook processing log cleanup failed', { error: error.message });
  }
}, 24 * 60 * 60 * 1000);
webhookLogCleanupInterval.unref();

// Stale cancellation watchdog (Fix #48: hourly check for cancel_submitted without completion)
const staleCancellationWatchdog = setInterval(() => {
  try {
    const staleOrders = findStaleCancellations(24);
    if (staleOrders.length > 0) {
      logger.warn('Found stale cancellations (>24 hours without webhook completion)', {
        count: staleOrders.length,
        orders: staleOrders.map((o) => ({ id: o.id, orderId: o.orderId })),
      });
      // Mark them as timeout for debugging
      staleOrders.forEach((order) => {
        try {
          updateRequest(order.tokenHash, {
            status: 'timeout_no_webhook',
          });
        } catch (e) {
          logger.warn('Failed to mark stale cancellation as timeout', { orderId: order.orderId, error: e.message });
        }
      });
    }
  } catch (error) {
    logger.error('Stale cancellation watchdog failed', { error: error.message });
  }
}, 60 * 60 * 1000); // Every hour
staleCancellationWatchdog.unref();

// ─── Graceful shutdown ───────────────────────────────────────────────

function shutdown() {
  logger.info('Shutting down gracefully...');

  try { stopEmailQueue(); } catch (e) { logger.warn('Failed to stop email queue', { error: e.message }); }
  try { stopSessionCleanup(); } catch (e) { logger.warn('Failed to stop session cleanup', { error: e.message }); }
  try { clearInterval(webhookCleanupInterval); } catch (e) { logger.warn('Failed to stop webhook cleanup', { error: e.message }); }
  try { clearInterval(webhookLogCleanupInterval); } catch (e) { logger.warn('Failed to stop webhook log cleanup', { error: e.message }); }
  try { clearInterval(staleCancellationWatchdog); } catch (e) { logger.warn('Failed to stop stale cancellation watchdog', { error: e.message }); }

  const forceExitTimeout = setTimeout(() => {
    logger.warn('Graceful shutdown timed out, forcing exit');
    process.exit(1);
  }, 10_000);
  forceExitTimeout.unref();

  server.close(() => {
    logger.info('HTTP server closed, all in-flight requests completed');
    try {
      closeDb();
    } catch (error) {
      logger.error('Error closing database', { error: error.message });
    }
    process.exit(0);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ─── Start HTTP server ──────────────────────────────────────────────

const server = app.listen(config.port, () => {
  logger.info('Server started', { port: config.port, apiVersion: config.apiVersion });
});
