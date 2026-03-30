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
  const subject = `Confirm cancellation of order ${escapeHtml(orderNumber)}`;
  const safeOrder = escapeHtml(orderNumber);
  const safeUrl = escapeHtml(confirmationUrl);

  const html = `
<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="X-UA-Compatible" content="IE=edge" />
  <meta name="x-apple-disable-message-reformatting" />
  <meta name="format-detection" content="telephone=no,address=no,email=no,date=no,url=no" />
  <title>Confirm Cancellation</title>
  <!--[if mso]>
  <noscript><xml>
    <o:OfficeDocumentSettings>
      <o:AllowPNG/>
      <o:PixelsPerInch>96</o:PixelsPerInch>
    </o:OfficeDocumentSettings>
  </xml></noscript>
  <style>
    table, td { border-collapse: collapse; mso-table-lspace: 0; mso-table-rspace: 0; }
    td { font-family: Arial, sans-serif; }
  </style>
  <![endif]-->
  <style>
    body, table, td, a { -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }
    table, td { mso-table-lspace: 0pt; mso-table-rspace: 0pt; }
    img { -ms-interpolation-mode: bicubic; border: 0; height: auto; line-height: 100%; outline: none; text-decoration: none; }
    body { margin: 0; padding: 0; width: 100% !important; height: 100% !important; }
    a[x-apple-data-detectors] { color: inherit !important; text-decoration: none !important; font-size: inherit !important; font-family: inherit !important; font-weight: inherit !important; line-height: inherit !important; }
    @media only screen and (max-width: 520px) {
      .oc-wrap { width: 100% !important; }
      .oc-card { padding: 28px 20px !important; }
      .oc-btn { padding: 14px 24px !important; }
    }
  </style>
</head>
<body style="margin:0;padding:0;background-color:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">

  <!-- Preheader (hidden text for inbox preview) -->
  <div style="display:none;font-size:1px;color:#f3f4f6;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">
    Confirm the cancellation of order ${safeOrder}. Click the button inside to proceed.
  </div>

  <!-- Outer wrapper table -->
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f3f4f6;">
    <tr>
      <td align="center" style="padding:40px 16px;">

        <!-- Card -->
        <table role="presentation" class="oc-wrap" width="480" cellpadding="0" cellspacing="0" border="0" style="max-width:480px;width:100%;">
          <tr>
            <td class="oc-card" style="background-color:#ffffff;border:1px solid #e5e7eb;border-radius:12px;padding:40px 32px;text-align:center;">

              <!-- Icon -->
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto 20px;">
                <tr>
                  <td style="width:56px;height:56px;background-color:#6366f1;border-radius:28px;text-align:center;vertical-align:middle;">
                    <!--[if mso]>
                    <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" style="width:56px;height:56px;v-text-anchor:middle;" arcsize="50%" fillcolor="#6366f1" stroke="f">
                      <v:textbox inset="0,0,0,0"><center style="color:#fff;font-size:24px;">&#10005;</center></v:textbox>
                    </v:roundrect>
                    <![endif]-->
                    <!--[if !mso]><!-->
                    <img src="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNiIgaGVpZ2h0PSIyNiIgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIiBzdHJva2U9IiNmZmYiIHN0cm9rZS13aWR0aD0iMi41IiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiPjxjaXJjbGUgY3g9IjEyIiBjeT0iMTIiIHI9IjEwIi8+PGxpbmUgeDE9IjE1IiB5MT0iOSIgeDI9IjkiIHkyPSIxNSIvPjxsaW5lIHgxPSI5IiB5MT0iOSIgeDI9IjE1IiB5Mj0iMTUiLz48L3N2Zz4=" alt="" width="26" height="26" style="display:block;margin:auto;padding-top:15px;" />
                    <!--<![endif]-->
                  </td>
                </tr>
              </table>

              <!-- Heading -->
              <h1 style="margin:0 0 8px;font-size:22px;font-weight:700;line-height:1.3;color:#111827;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
                Confirm Your Cancellation
              </h1>

              <!-- Subtext -->
              <p style="margin:0 0 28px;font-size:15px;line-height:1.6;color:#6b7280;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
                We received a request to cancel order <strong style="color:#111827;">${safeOrder}</strong>. If this was you, click the button below to confirm.
              </p>

              <!-- CTA Button -->
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto 28px;">
                <tr>
                  <td style="border-radius:8px;background-color:#111827;">
                    <!--[if mso]>
                    <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" href="${safeUrl}" style="width:220px;height:44px;v-text-anchor:middle;" arcsize="18%" fillcolor="#111827" stroke="f">
                      <v:textbox inset="0,0,0,0"><center style="color:#fff;font-family:Arial,sans-serif;font-size:15px;font-weight:600;">Confirm Cancellation</center></v:textbox>
                    </v:roundrect>
                    <![endif]-->
                    <!--[if !mso]><!-->
                    <a href="${safeUrl}" target="_blank" class="oc-btn" style="display:inline-block;padding:14px 32px;background-color:#111827;color:#ffffff;text-decoration:none;border-radius:8px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;font-weight:600;line-height:1;text-align:center;mso-hide:all;">
                      Confirm Cancellation
                    </a>
                    <!--<![endif]-->
                  </td>
                </tr>
              </table>

              <!-- Expiry notice -->
              <p style="margin:0 0 6px;font-size:13px;line-height:1.5;color:#9ca3af;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
                This link expires in <strong style="color:#6b7280;">${ttlMinutes} minutes</strong> and can only be used once.
              </p>

              <!-- Divider -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0;">
                <tr>
                  <td style="border-top:1px solid #e5e7eb;font-size:0;line-height:0;height:1px;">&nbsp;</td>
                </tr>
              </table>

              <!-- Safety note -->
              <p style="margin:0;font-size:13px;line-height:1.5;color:#9ca3af;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
                If you did not request this cancellation, you can safely ignore this email. Your order will not be affected.
              </p>

            </td>
          </tr>
        </table>

        <!-- Footer -->
        <table role="presentation" class="oc-wrap" width="480" cellpadding="0" cellspacing="0" border="0" style="max-width:480px;width:100%;">
          <tr>
            <td style="padding:24px 32px 0;text-align:center;">
              <p style="margin:0;font-size:12px;line-height:1.5;color:#9ca3af;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
                This is an automated message. Please do not reply to this email.
              </p>
            </td>
          </tr>
        </table>

      </td>
    </tr>
  </table>

</body>
</html>
  `.trim();

  const text = [
    `Confirm Your Order Cancellation`,
    ``,
    `We received a request to cancel order ${orderNumber}.`,
    ``,
    `If this was you, confirm the cancellation by visiting:`,
    `${confirmationUrl}`,
    ``,
    `This link expires in ${ttlMinutes} minutes and can only be used once.`,
    ``,
    `If you did not request this cancellation, you can safely ignore this email.`,
    `Your order will not be affected.`,
  ].join('\n');

  await sendWithRetry({
    from: config.emailFrom,
    to,
    subject,
    text,
    html,
  });
}
