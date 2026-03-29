/**
 * Structured JSON logger with audit trail support.
 * Writes structured logs to stdout/stderr for easy integration
 * with log aggregation services (Datadog, CloudWatch, etc.).
 */

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLevel = LOG_LEVELS[process.env.LOG_LEVEL || 'info'] ?? LOG_LEVELS.info;

function formatLog(level, message, meta = {}) {
  return JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    message,
    ...meta,
  });
}

export const logger = {
  debug(message, meta) {
    if (currentLevel <= LOG_LEVELS.debug) {
      console.log(formatLog('debug', message, meta));
    }
  },
  info(message, meta) {
    if (currentLevel <= LOG_LEVELS.info) {
      console.log(formatLog('info', message, meta));
    }
  },
  warn(message, meta) {
    if (currentLevel <= LOG_LEVELS.warn) {
      console.warn(formatLog('warn', message, meta));
    }
  },
  error(message, meta) {
    if (currentLevel <= LOG_LEVELS.error) {
      console.error(formatLog('error', message, meta));
    }
  },
};

/**
 * Log an audit event for cancellation tracking.
 * These events are always logged regardless of LOG_LEVEL.
 * traceId should be included in the details object for request correlation (Fix #12).
 */
export function auditLog(action, details) {
  console.log(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'audit',
      action,
      ...details,
    }),
  );
}
