/**
 * Global test setup.
 *
 * Sets required environment variables BEFORE any app module is imported,
 * so config.js validation passes in test processes.
 */

// Set test environment variables before anything else loads
process.env.NODE_ENV = 'test';
process.env.PORT = '3199'; // test port (not used — supertest handles its own)
process.env.APP_BASE_URL = 'https://test-app.example.com';
process.env.SHOPIFY_STORE_DOMAIN = 'test-store.myshopify.com';
process.env.SHOPIFY_ADMIN_API_VERSION = '2026-01';
process.env.SHOPIFY_ADMIN_ACCESS_TOKEN = 'shpat_test_token_000000000000000000';
process.env.SHOPIFY_APP_PROXY_SHARED_SECRET = 'test_proxy_secret_1234567890';
process.env.SHOPIFY_WEBHOOK_SECRET = 'test_webhook_secret_1234567890';
process.env.SMTP_HOST = 'localhost';
process.env.SMTP_PORT = '2525';
process.env.SMTP_SECURE = 'false';
process.env.SMTP_USER = 'test';
process.env.SMTP_PASS = 'test';
process.env.EMAIL_FROM = 'test@example.com';
process.env.ADMIN_API_TOKEN = 'test_admin_token_abcdef1234567890';
process.env.CANCEL_TOKEN_TTL_MINUTES = '30';
process.env.LOG_LEVEL = 'error'; // suppress logs in tests
process.env.DATA_DIR = ''; // will be overridden per-test if needed
process.env.TRUST_PROXY = '0';
