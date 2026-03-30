/**
 * Pluggable error monitoring integration.
 *
 * Provides a centralized error capture interface that works out-of-the-box
 * with structured logging. When an external error tracking service (Sentry,
 * Datadog, Bugsnag, etc.) is configured via SENTRY_DSN, errors are forwarded
 * to it automatically.
 *
 * Setup with Sentry:
 *   1. npm install @sentry/node
 *   2. Set SENTRY_DSN in your .env
 *   3. The module auto-initializes on import
 *
 * Without SENTRY_DSN, all errors are still logged via the structured logger.
 */

import { logger } from './logger.js';

let sentryClient = null;

/**
 * Initialize the error tracking service if configured.
 * Called once at module load time.
 */
function init() {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;

  try {
    // Dynamic import to avoid requiring @sentry/node as a dependency.
    // The package is only loaded when SENTRY_DSN is set.
    import('@sentry/node').then((Sentry) => {
      Sentry.init({
        dsn,
        environment: process.env.NODE_ENV || 'production',
        release: process.env.npm_package_version || '0.12.0',
        tracesSampleRate: parseFloat(process.env.SENTRY_TRACES_SAMPLE_RATE || '0.1'),
        beforeSend(event) {
          // Scrub sensitive data before sending to external service
          if (event.request?.headers) {
            delete event.request.headers['authorization'];
            delete event.request.headers['cookie'];
            delete event.request.headers['x-shopify-access-token'];
          }
          return event;
        },
      });
      sentryClient = Sentry;
      logger.info('Error tracking service initialized');
    }).catch((err) => {
      logger.warn('Error tracking service not available (install @sentry/node to enable)', {
        error: err.message,
      });
    });
  } catch (err) {
    logger.warn('Error tracking service initialization failed', { error: err.message });
  }
}

init();

/**
 * Capture an error with optional context.
 * Logs the error and forwards to the external service if configured.
 *
 * @param {Error} error - The error to capture
 * @param {object} context - Additional context (userId, orderId, traceId, etc.)
 */
export function captureError(error, context = {}) {
  logger.error(error.message, {
    stack: error.stack,
    ...context,
  });

  if (sentryClient) {
    sentryClient.withScope((scope) => {
      for (const [key, value] of Object.entries(context)) {
        scope.setExtra(key, value);
      }
      if (context.traceId) {
        scope.setTag('traceId', context.traceId);
      }
      sentryClient.captureException(error);
    });
  }
}

/**
 * Express error-handling middleware.
 * Mount as the LAST middleware to catch unhandled errors from routes.
 *
 * Usage: app.use(expressErrorHandler);
 */
export function expressErrorHandler(err, req, res, _next) {
  captureError(err, {
    method: req.method,
    url: req.originalUrl,
    ip: req.ip,
    traceId: req.traceId,
  });

  if (res.headersSent) return;

  res.status(500).send('An unexpected error occurred. Please try again later.');
}

/**
 * Capture unhandled rejections and uncaught exceptions.
 * Call once during application startup.
 */
export function setupGlobalErrorHandlers() {
  process.on('unhandledRejection', (reason) => {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    captureError(error, { type: 'unhandledRejection' });
  });

  process.on('uncaughtException', (error) => {
    captureError(error, { type: 'uncaughtException' });
    // Give the error tracker time to flush before crashing
    setTimeout(() => process.exit(1), 2000);
  });
}
