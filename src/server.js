import app, { adminSessionCleanupInterval } from './app.js';
import { config } from './config.js';
import { logger } from './logger.js';
import { startEmailQueue, stopEmailQueue } from './emailQueue.js';
import { startSessionCleanup, stopSessionCleanup } from './adminAuth.js';
import { cleanupOldWebhookEvents, closeDb } from './storage.js';

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

// ─── Graceful shutdown ───────────────────────────────────────────────

function shutdown() {
  logger.info('Shutting down gracefully...');

  try { stopEmailQueue(); } catch (e) { logger.warn('Failed to stop email queue', { error: e.message }); }
  try { stopSessionCleanup(); } catch (e) { logger.warn('Failed to stop session cleanup', { error: e.message }); }
  try { clearInterval(adminSessionCleanupInterval); } catch (e) { logger.warn('Failed to stop admin session cleanup', { error: e.message }); }
  try { clearInterval(webhookCleanupInterval); } catch (e) { logger.warn('Failed to stop webhook cleanup', { error: e.message }); }

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
