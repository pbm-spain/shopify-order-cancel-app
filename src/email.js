import nodemailer from 'nodemailer';
import { config } from './config.js';
import { escapeHtml } from './utils.js';
import { logger } from './logger.js';

const transporter = nodemailer.createTransport({
  host: config.smtpHost,
  port: config.smtpPort,
  secure: config.smtpSecure,
  auth: {
    user: config.smtpUser,
    pass: config.smtpPass,
  },
});

/**
 * Send an email with automatic retry on transient failures.
 * Uses exponential backoff: 1s, 2s, 4s.
 */
async function sendWithRetry(mailOptions, maxRetries = 3, delayMs = 1000) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const info = await transporter.sendMail(mailOptions);
      logger.info('Email sent successfully', {
        to: mailOptions.to,
        messageId: info.messageId,
        attempt,
      });
      return info;
    } catch (error) {
      logger.warn('Email send failed', {
        to: mailOptions.to,
        attempt,
        maxRetries,
        error: error.message,
      });

      if (attempt === maxRetries) {
        logger.error('Email send exhausted all retries', {
          to: mailOptions.to,
          error: error.message,
        });
        throw error;
      }

      // Exponential backoff
      const wait = delayMs * Math.pow(2, attempt - 1);
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}

export async function sendConfirmationEmail({ to, orderNumber, confirmationUrl, ttlMinutes }) {
  const subject = `Confirm cancellation of your order ${orderNumber}`;
  const html = `
    <div style="font-family: Arial, sans-serif; line-height: 1.5; color: #111;">
      <h2>Confirm your order cancellation</h2>
      <p>We received a request to cancel order <strong>${escapeHtml(orderNumber)}</strong>.</p>
      <p>If this was you, please confirm the cancellation by clicking the button below:</p>
      <p>
        <a href="${escapeHtml(confirmationUrl)}" style="display:inline-block;padding:12px 18px;background:#111;color:#fff;text-decoration:none;border-radius:6px;">
          Confirm Cancellation
        </a>
      </p>
      <p>This link expires in ${ttlMinutes} minutes and can only be used once.</p>
      <p>If you did not request this cancellation, you can safely ignore this email.</p>
    </div>
  `;

  const text = [
    `We received a request to cancel order ${orderNumber}.`,
    `Confirm the cancellation here: ${confirmationUrl}`,
    `This link expires in ${ttlMinutes} minutes.`,
  ].join('\n');

  await sendWithRetry({
    from: config.emailFrom,
    to,
    subject,
    text,
    html,
  });
}
