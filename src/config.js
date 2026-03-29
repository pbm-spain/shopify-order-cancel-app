import 'dotenv/config';

function env(name, fallback = undefined) {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === '') {
    throw new Error(`Missing environment variable: ${name}`);
  }
  return value;
}

function envPort(name, fallback) {
  const raw = process.env[name] || String(fallback);
  const p = Number(raw);
  if (isNaN(p) || p < 1 || p > 65535) {
    throw new Error(`${name} must be a valid port (1-65535), got: ${raw}`);
  }
  return p;
}

function envPositiveInt(name, fallback) {
  const raw = process.env[name] || String(fallback);
  const n = Number(raw);
  if (isNaN(n) || n < 0 || !Number.isFinite(n)) {
    throw new Error(`${name} must be a non-negative number, got: ${raw}`);
  }
  return n;
}

function envUrl(name) {
  const raw = env(name);
  try {
    new URL(raw);
  } catch {
    throw new Error(`${name} must be a valid URL, got: ${raw}`);
  }
  return raw;
}

export const config = {
  port: envPort('PORT', 3000),
  appBaseUrl: envUrl('APP_BASE_URL'),
  shopDomain: env('SHOPIFY_STORE_DOMAIN'),
  apiVersion: process.env.SHOPIFY_ADMIN_API_VERSION || '2026-01',
  adminToken: env('SHOPIFY_ADMIN_ACCESS_TOKEN'),
  appProxySecret: env('SHOPIFY_APP_PROXY_SHARED_SECRET'),
  emailFrom: env('EMAIL_FROM'),
  smtpHost: env('SMTP_HOST'),
  smtpPort: envPort('SMTP_PORT', 465),
  smtpSecure: String(process.env.SMTP_SECURE || 'true') === 'true',
  smtpUser: env('SMTP_USER'),
  smtpPass: env('SMTP_PASS'),
  tokenTtlMinutes: envPositiveInt('CANCEL_TOKEN_TTL_MINUTES', 30),
  cancelNotifyCustomer: String(process.env.CANCEL_NOTIFY_CUSTOMER || 'true') === 'true',
  cancelRestock: String(process.env.CANCEL_RESTOCK || 'true') === 'true',
  cancelRefund: String(process.env.CANCEL_REFUND || 'false') === 'true',
  orderLookbackDays: envPositiveInt('ORDER_LOOKBACK_DAYS', 90),

  // Rate limiting
  rateLimitWindowMs: envPositiveInt('RATE_LIMIT_WINDOW_MS', 60_000),
  rateLimitMaxRequests: envPositiveInt('RATE_LIMIT_MAX_REQUESTS', 5),

  // Admin panel
  adminApiToken: env('ADMIN_API_TOKEN'),

  // Logging
  logLevel: process.env.LOG_LEVEL || 'info',

  // Webhooks
  webhookSecret: process.env.SHOPIFY_WEBHOOK_SECRET || '',
};
