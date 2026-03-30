/**
 * Email Retry Queue
 *
 * Background worker that periodically attempts to send unsent emails.
 * Implements exponential backoff for failed attempts.
 *
 * - Queries for unsent emails every 60 seconds
 * - Attempts delivery with exponential backoff (1s, 2s, 4s...)
 * - Tracks attempt count in database
 * - Marks successful sends
 * - Logs failures with attempt count
 */

import { logger } from './logger.js';
import {
  getUnsentEmails,
  markEmailSent,
  incrementEmailAttempt,
  getFailedEmails,
  updateTokenHash,
} from './storage.js';
import { sendConfirmationEmail } from './email.js';
import { config } from './config.js';
import { createToken, hashToken, minutesFromNow } from './utils.js';

let emailQueueInterval = null;
let isRunning = false;

/**
 * Calculate exponential backoff delay in milliseconds.
 * Formula: baseDelay * (2 ^ attemptNumber)
 */
function calculateBackoffDelay(attemptCount) {
  const baseDelay = 1000; // 1 second
  return baseDelay * Math.pow(2, attemptCount);
}

/**
 * Process one unsent email request.
 * Sends email FIRST, then updates DB with new token only if send succeeds.
 * Returns true if sent successfully, false otherwise.
 */
async function processEmailRequest(request) {
  try {
    // Calculate backoff delay based on attempt count (Fix #22: use last attempt time, not createdAt)
    const delayMs = calculateBackoffDelay(request.emailAttempts);
    const referenceTime = request.lastEmailAttemptAt
      ? new Date(request.lastEmailAttemptAt).getTime()
      : new Date(request.createdAt).getTime();
    const timeSinceLastAttempt = Date.now() - referenceTime;

    // Only process if enough time has passed since last attempt (backoff window)
    if (timeSinceLastAttempt < delayMs) {
      logger.debug('Email backoff window not yet reached', {
        requestId: request.id,
        attempts: request.emailAttempts,
        nextRetryMs: delayMs - timeSinceLastAttempt,
      });
      return false; // Not ready yet
    }

    // Generate new token for retry (Fix #5)
    const newToken = createToken();
    const newTokenHash = hashToken(newToken);
    const newExpiresAt = minutesFromNow(config.tokenTtlMinutes);

    // Build confirmation URL with new token
    const confirmationUrl = `${config.appBaseUrl}/confirm?token=${encodeURIComponent(newToken)}`;

    // 1. SEND EMAIL FIRST (Fix #8: send before updating DB token)
    // If this fails, we don't update the DB, keeping the old token valid
    await sendConfirmationEmail({
      to: request.email,
      orderNumber: request.orderNumber,
      confirmationUrl,
      ttlMinutes: config.tokenTtlMinutes,
    });

    // 2. ONLY update DB with new token hash AFTER successful send
    updateTokenHash(request.id, newTokenHash, newExpiresAt);

    // 3. Mark as sent
    markEmailSent(request.id);

    logger.info('Email sent successfully via retry queue', {
      requestId: request.id,
      email: request.email,
      orderNumber: request.orderNumber,
      attempts: request.emailAttempts + 1,
    });

    return true;
  } catch (error) {
    logger.warn('Email send failed, will retry', {
      requestId: request.id,
      email: request.email,
      orderNumber: request.orderNumber,
      attempts: request.emailAttempts + 1,
      error: error.message,
    });

    // Don't update token if email fails — keep old token valid
    // Increment attempt count and let retry happen later
    incrementEmailAttempt(request.id);
    return false;
  }
}

/**
 * Worker function that runs every 60 seconds to process the email queue.
 */
async function processEmailQueue() {
  if (isRunning) {
    logger.debug('Email queue already processing, skipping');
    return;
  }

  isRunning = true;

  try {
    // Get all unsent emails (email_sent = 0, attempts < 5)
    const unsentEmails = getUnsentEmails();

    if (unsentEmails.length === 0) {
      logger.debug('No unsent emails in queue');
      isRunning = false;
      return;
    }

    logger.info('Processing email queue', { count: unsentEmails.length });

    let successCount = 0;
    let retryCount = 0;

    // Process each email
    for (const request of unsentEmails) {
      const success = await processEmailRequest(request);
      if (success) {
        successCount++;
      } else if (request.emailAttempts < 5) {
        retryCount++;
      }
    }

    logger.info('Email queue processing completed', {
      total: unsentEmails.length,
      sent: successCount,
      retrying: retryCount,
    });

    // Log any emails that have exhausted retries
    const failedEmails = getFailedEmails(5);
    if (failedEmails.length > 0) {
      logger.warn('Emails exhausted retries', {
        count: failedEmails.length,
        emails: failedEmails.map((e) => ({
          id: e.id,
          email: e.email,
          orderNumber: e.orderNumber,
          attempts: e.emailAttempts,
        })),
      });
    }
  } catch (error) {
    logger.error('Error processing email queue', { error: error.message });
  } finally {
    isRunning = false;
  }
}

/**
 * Start the email queue background worker.
 * Runs processEmailQueue every 60 seconds.
 */
export function startEmailQueue() {
  if (emailQueueInterval) {
    logger.warn('Email queue already started');
    return;
  }

  logger.info('Starting email queue worker (60 second interval)');
  emailQueueInterval = setInterval(() => {
    processEmailQueue().catch((error) => {
      logger.error('Unhandled error in email queue', { error: error.message });
    });
  }, 60 * 1000); // 60 seconds

  // Don't keep the process alive if this is the only active timer
  emailQueueInterval.unref();
}

/**
 * Stop the email queue background worker.
 */
export function stopEmailQueue() {
  if (emailQueueInterval) {
    logger.info('Stopping email queue worker');
    clearInterval(emailQueueInterval);
    emailQueueInterval = null;
  }
}
