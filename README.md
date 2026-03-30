# Shopify Order Cancel Confirmation App

[![CI](https://github.com/pbm-spain/shopify-order-cancel-app/actions/workflows/ci.yml/badge.svg)](https://github.com/pbm-spain/shopify-order-cancel-app/actions/workflows/ci.yml)

A self-hosted Shopify app that lets customers request order cancellations through a secure, email-confirmed workflow. The store owner retains full control over refund approvals via an admin dashboard.

## How It Works

```
Customer fills form ─► HMAC verified ─► Email with confirmation link
                                              │
                                              ▼
                                     Customer clicks link
                                              │
                                              ▼
                              ┌───────────────┴───────────────┐
                              │                               │
                     Auto-refund ON                  Auto-refund OFF
                              │                               │
                     Cancel + Refund              Cancel + Tag "refund-pending"
                                                              │
                                                              ▼
                                                   Admin approves/denies
                                                   refund in dashboard
```

**Key features:**

- Email-confirmed cancellation (time-limited, single-use tokens)
- Two refund modes: automatic or admin-approval
- Admin dashboard with paginated pending refunds and cancellation history
- Shopify webhook integration for real-time order status sync
- Background email retry queue with exponential backoff
- Production-hardened security (HMAC, CSRF, rate limiting, CSP, timing-safe comparisons)

---

## Table of Contents

- [Requirements](#requirements)
- [Quick Start](#quick-start)
- [Environment Variables](#environment-variables)
- [Shopify Configuration](#shopify-configuration)
- [Architecture](#architecture)
- [API Endpoints](#api-endpoints)
- [Admin Dashboard](#admin-dashboard)
- [Webhooks](#webhooks)
- [Security](#security)
- [Deployment](#deployment)
- [Monitoring & Logging](#monitoring--logging)
- [Testing](#testing)
- [Troubleshooting](#troubleshooting)

---

## Requirements

- **Node.js** 20+ (tested on 20 and 22)
- **Shopify Partner account** with a custom app
- **SMTP provider** (Resend, Mailgun, SendGrid, Amazon SES, etc.)
- **HTTPS** endpoint (required by Shopify App Proxy)

---

## Quick Start

```bash
# Clone the repository
git clone https://github.com/pbm-spain/shopify-order-cancel-app.git
cd shopify-order-cancel-app

# Install dependencies
npm ci

# Copy and configure environment variables
cp .env.example .env
# Edit .env with your values (see Environment Variables section)

# Generate a secure admin token
openssl rand -hex 32
# Paste the output as ADMIN_API_TOKEN in .env

# Start the server
npm start

# Or start with auto-reload for development
npm run dev
```

The server starts on `http://localhost:3000` by default. The `/health` endpoint returns `{ "ok": true }` when the app is running correctly.

---

## Environment Variables

### Required

| Variable | Description | Example |
|---|---|---|
| `APP_BASE_URL` | Public HTTPS URL of your app | `https://cancel.mystore.com` |
| `SHOPIFY_STORE_DOMAIN` | Your `.myshopify.com` domain | `my-store.myshopify.com` |
| `SHOPIFY_ADMIN_ACCESS_TOKEN` | Admin API access token (`shpat_...`) | `shpat_xxxxxxxxxxxx` |
| `SHOPIFY_APP_PROXY_SHARED_SECRET` | App Proxy shared secret from Partners | (from Shopify Partners) |
| `SHOPIFY_WEBHOOK_SECRET` | Webhook signing secret | (from Shopify Partners) |
| `SMTP_HOST` | SMTP server hostname | `smtp.resend.com` |
| `SMTP_PORT` | SMTP server port | `465` |
| `SMTP_USER` | SMTP authentication user | `resend` |
| `SMTP_PASS` | SMTP authentication password | `re_xxxxxxxxxxxx` |
| `EMAIL_FROM` | Sender email address | `Store <no-reply@mystore.com>` |
| `ADMIN_API_TOKEN` | Secret token for admin dashboard access | (use `openssl rand -hex 32`) |

### Optional

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Server port |
| `SHOPIFY_ADMIN_API_VERSION` | `2026-01` | Shopify Admin API version |
| `SMTP_SECURE` | `true` | Use TLS for SMTP connection |
| `CANCEL_TOKEN_TTL_MINUTES` | `30` | Confirmation link expiry time (minutes) |
| `CANCEL_NOTIFY_CUSTOMER` | `true` | Shopify sends its own cancellation email |
| `CANCEL_RESTOCK` | `true` | Restock items on cancellation |
| `CANCEL_REFUND` | `false` | Initial auto-refund setting (configurable in admin) |
| `ORDER_LOOKBACK_DAYS` | `90` | Only allow cancellation for orders within this period |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rate limit window for cancel requests (ms) |
| `RATE_LIMIT_MAX_REQUESTS` | `5` | Max cancel requests per IP per window |
| `LOG_LEVEL` | `info` | Log verbosity: `debug`, `info`, `warn`, `error` |
| `DATA_DIR` | `./data` | Directory for SQLite database file |
| `TRUST_PROXY` | `0` | Set to `1` when behind exactly one reverse proxy |

---

## Shopify Configuration

### 1. Create a Custom App

1. Go to **Shopify Partners** > **Apps** > **Create app**
2. Set the **App URL** to your `APP_BASE_URL`
3. Copy `shopify.app.toml.example` to `shopify.app.toml` and fill in your `client_id`

### 2. Required API Scopes

```
write_orders, read_orders
```

### 3. Configure the App Proxy

In your app settings under **App Proxy**:

| Field | Value |
|---|---|
| Sub path prefix | `apps` |
| Sub path | `order-cancel` |
| Proxy URL | `https://your-app.example.com/proxy` |

This makes the cancellation form accessible at:
```
https://your-store.myshopify.com/apps/order-cancel/cancel-order
```

### 4. Register Webhooks

In your app settings, register these webhook topics:

| Topic | Endpoint | Purpose |
|---|---|---|
| `orders/updated` | `https://your-app.example.com/webhooks/orders/updated` | Auto-deny if order ships |
| `orders/cancelled` | `https://your-app.example.com/webhooks/orders/cancelled` | Sync external cancellations |
| `refunds/create` | `https://your-app.example.com/webhooks/refunds/create` | Sync external refunds |

Copy the **Webhook signing secret** to `SHOPIFY_WEBHOOK_SECRET` in your `.env`.

### 5. Link the Form in Your Store

Add a link to the cancellation form in your store's theme (e.g., footer, order status page, or a dedicated page):

```html
<a href="/apps/order-cancel/cancel-order">Cancel an Order</a>
```

Or use Liquid on the order status page:

```liquid
<a href="/apps/order-cancel/cancel-order?email={{ order.email }}&orderNumber={{ order.name }}">
  Request Cancellation
</a>
```

---

## Architecture

### Project Structure

```
src/
├── server.js        # Express app, routes, middleware, HTML template rendering
├── config.js        # Environment variable loading with validation
├── shopify.js       # Shopify Admin GraphQL API client (queries + mutations)
├── storage.js       # SQLite database layer (better-sqlite3, WAL mode)
├── appProxy.js      # Shopify App Proxy HMAC signature verification
├── adminAuth.js     # Admin session authentication (opaque tokens, IP binding)
├── csrf.js          # CSRF protection (double-submit cookie pattern)
├── email.js         # Nodemailer transport + confirmation email template
├── emailQueue.js    # Background email retry worker (exponential backoff)
├── rateLimit.js     # In-memory sliding window rate limiter
├── logger.js        # Structured JSON logging + audit trail
├── utils.js         # Token generation, hashing, input normalization
└── webhooks.js      # Shopify webhook handlers (HMAC verification + processing)
views/
├── form.html        # Customer cancellation request form
├── admin.html       # Admin dashboard (settings, pending refunds, history)
├── success.html     # Cancellation confirmed page
└── request-sent.html # "Check your email" confirmation page
```

### Tech Stack

| Component | Technology |
|---|---|
| Runtime | Node.js 20+ (ES modules) |
| Web framework | Express 4.x |
| Database | SQLite via better-sqlite3 (WAL mode) |
| Email | Nodemailer 8.x |
| Shopify API | Admin GraphQL API (2026-01) |
| CI | GitHub Actions (Node 20/22, ESLint, npm audit) |

### Database

SQLite database stored at `DATA_DIR/cancel-requests.db` with WAL mode for concurrent access. Three tables:

- **`cancel_requests`** — Cancellation requests with token hashes, statuses, and refund state
- **`admin_settings`** — Key-value store for admin-configurable settings
- **`webhook_events`** — Webhook deduplication (auto-cleaned after 30 days)

### Data Flow

1. **Request phase:** Customer submits form → App Proxy HMAC verified → Order looked up via GraphQL → Token generated (SHA-256 hashed in DB) → Confirmation email sent
2. **Confirmation phase:** Customer clicks link → Token validated → Order re-verified → Cancel mutation sent to Shopify (async Job) → DB updated
3. **Refund phase (if manual):** Order tagged `refund-pending` in Shopify → Admin approves/denies via dashboard → Refund created via GraphQL with idempotency key

### Key Design Decisions

- **Async cancellation:** Shopify's `orderCancel` returns a Job, not an immediate result. The app relies on the `orders/cancelled` webhook to detect completion rather than polling.
- **Token hashing:** Confirmation tokens are stored as SHA-256 hashes — raw tokens only exist in the email link and memory during generation.
- **Atomic operations:** Token usage and refund approvals use SQL `WHERE ... IS NULL` / `WHERE ... = expected_status` patterns to prevent race conditions.
- **Idempotent refunds:** The `refundCreate` mutation uses Shopify's `@idempotent` GraphQL directive with a deterministic key.

---

## API Endpoints

### Public

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Health check (tests DB connectivity) |
| `GET` | `/cancel-order` | Customer cancellation form |
| `POST` | `/proxy/request` | Submit cancellation request (App Proxy HMAC + CSRF + rate limited) |
| `GET` | `/confirm?token=<token>` | Confirm cancellation from email link (rate limited) |

### Webhooks (HMAC-verified)

| Method | Path | Description |
|---|---|---|
| `POST` | `/webhooks/orders/updated` | Denies pending requests if order ships |
| `POST` | `/webhooks/orders/cancelled` | Syncs external cancellations |
| `POST` | `/webhooks/refunds/create` | Syncs external refunds |

### Admin (session or Bearer token required)

| Method | Path | Description |
|---|---|---|
| `POST` | `/admin/login` | Login with admin token (rate limited) |
| `GET` | `/admin/logout` | Logout and clear session |
| `GET` | `/admin` | Dashboard (settings, pending refunds, history) |
| `POST` | `/admin/api/settings` | Update settings (JSON API, CSRF protected) |
| `POST` | `/admin/refund/approve` | Approve a pending refund (CSRF protected) |
| `POST` | `/admin/refund/deny` | Deny a pending refund (CSRF protected) |

---

## Admin Dashboard

Access the dashboard at `https://your-app.example.com/admin`. Log in with the `ADMIN_API_TOKEN` value.

### Settings

- **Auto-refund toggle:** When ON, cancellations automatically include a refund. When OFF, orders are cancelled without refund and tagged `refund-pending` for admin review.
- **Allowed fulfillment statuses:** Select which Shopify fulfillment statuses allow cancellation (e.g., Unfulfilled, Pending Fulfillment).
- **Allowed financial statuses:** Select which Shopify financial statuses allow cancellation (e.g., Pending, Authorized, Paid).

### Pending Refunds

When auto-refund is OFF, pending refunds appear in a paginated table. Each row shows the order number, customer email, cancellation date, and Approve/Deny buttons. Approving a refund:

1. Verifies the order is still cancelled in Shopify
2. Atomically transitions the refund status (prevents double-approval)
3. Creates the refund via GraphQL with an idempotency key
4. Removes the `refund-pending` tag from the order

### Recent Cancellations

A paginated table of all processed cancellations with their refund status (Automatic, Approved, Denied, Pending, Error).

---

## Webhooks

Webhooks keep the app in sync when orders are modified outside the app (e.g., from the Shopify admin panel).

| Webhook | Behavior |
|---|---|
| `orders/updated` | If an order with a pending cancellation changes to a non-allowed fulfillment status, the request is auto-denied |
| `orders/cancelled` | If an order is cancelled externally, the pending request is marked `cancelled_externally` |
| `refunds/create` | If a refund is created externally, the pending refund is marked as approved |

**Implementation details:**
- All webhooks verify HMAC-SHA256 signatures using the raw request body
- Atomic deduplication prevents double-processing (via `webhook_events` table)
- REST numeric order IDs are converted to GraphQL GIDs for database lookups
- Webhook events older than 30 days are automatically cleaned up
- Handlers always return `200 OK` to prevent Shopify from retrying indefinitely

---

## Security

### Authentication & Authorization

| Layer | Mechanism |
|---|---|
| App Proxy | HMAC-SHA256 signature verification (Shopify shared secret) |
| Webhooks | HMAC-SHA256 signature verification (webhook secret) |
| Admin dashboard | Opaque server-side session tokens with IP binding |
| Admin API | Bearer token authentication |

### CSRF Protection

- **Customer forms:** Double-submit cookie pattern
- **Admin panel:** Session-based CSRF tokens (one per session, timing-safe comparison)

### Rate Limiting

| Endpoint | Limit | Window |
|---|---|---|
| `POST /proxy/request` (per IP) | 5 requests | 1 minute |
| `POST /proxy/request` (per email) | 3 requests | 1 hour |
| `GET /confirm` (per IP) | 30 requests | 1 hour |
| `POST /admin/login` (per IP) | 5 attempts | 15 minutes |
| `POST /admin/api/settings` (per IP) | 20 requests | 1 minute |

### Token Security

- Confirmation tokens: 64-character hex strings (256-bit entropy)
- Tokens are hashed with SHA-256 before database storage
- Tokens are single-use (atomic `WHERE used_at IS NULL` check)
- Tokens expire after `CANCEL_TOKEN_TTL_MINUTES` (default: 30)

### HTTP Security Headers

```
Content-Security-Policy: default-src 'self'; script-src 'self' 'nonce-<random>'; style-src 'self' 'nonce-<random>';
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Referrer-Policy: strict-origin-when-cross-origin
Strict-Transport-Security: max-age=31536000; includeSubDomains  (when HTTPS)
```

### Additional Protections

- All sensitive comparisons use `crypto.timingSafeEqual`
- SQL injection prevention via prepared statements (better-sqlite3)
- Input validation on all user inputs (email format, order number regex, UUID format)
- Open redirect protection on admin login
- Content-Type validation (415 for unsupported media types)
- Request body size limit (10KB)
- Admin session IP binding (session fixation protection)
- `TRUST_PROXY` must be explicitly enabled — prevents X-Forwarded-For spoofing that would bypass rate limits

---

## Deployment

### Railway / Render

1. Connect your GitHub repository
2. Set all environment variables from [Environment Variables](#environment-variables)
3. Set the build command to `npm ci`
4. Set the start command to `npm start`
5. Ensure `DATA_DIR` points to a persistent volume (e.g., `/data`)

### VPS with Nginx

```nginx
server {
    listen 443 ssl;
    server_name cancel.mystore.com;

    ssl_certificate     /etc/letsencrypt/live/cancel.mystore.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/cancel.mystore.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

When behind a reverse proxy, set `TRUST_PROXY=1` in your `.env` so Express reads the correct client IP from `X-Forwarded-For`. Without this, all rate limits would see the proxy's IP instead of the client's.

### Process Management (systemd)

```ini
[Unit]
Description=Shopify Order Cancel App
After=network.target

[Service]
Type=simple
User=deploy
WorkingDirectory=/opt/shopify-cancel-app
ExecStart=/usr/bin/node src/server.js
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production
EnvironmentFile=/opt/shopify-cancel-app/.env

[Install]
WantedBy=multi-user.target
```

### Persistent Storage

The SQLite database is stored at `DATA_DIR/cancel-requests.db`. Ensure this directory:
- Is on persistent storage (not ephemeral container filesystem)
- Has write permissions for the app process
- Is backed up regularly

### Graceful Shutdown

The app handles `SIGINT` and `SIGTERM` signals:
1. Stops accepting new connections
2. Waits for in-flight requests to complete (10s timeout)
3. Stops background workers (email queue, session cleanup, webhook cleanup)
4. Optimizes and closes the SQLite database
5. Exits cleanly

---

## Monitoring & Logging

### Structured Logging

All logs are JSON-formatted to stdout/stderr, compatible with log aggregation services (Datadog, CloudWatch, ELK, Loki, etc.):

```json
{"timestamp":"2026-03-30T10:00:00.000Z","level":"info","message":"Order cancelled successfully","orderId":"gid://shopify/Order/123","jobId":"gid://shopify/Job/456","withRefund":false}
```

### Log Levels

| Level | Content |
|---|---|
| `debug` | GraphQL error details, webhook skips, detailed flow tracing |
| `info` | Order searches, cancellations, refunds, email sends, settings changes |
| `warn` | Invalid signatures, failed email sends, parse errors |
| `error` | Shopify API errors, unhandled failures, health check failures |
| `audit` | Always logged regardless of level — cancel requests, confirmations, refund approvals/denials |

### Audit Trail

Security-sensitive events are logged at `audit` level with structured data including:
- `cancel_requested` — customer submitted a cancellation
- `cancel_confirmed` / `cancel_confirmed_refund_pending` — customer confirmed via email link
- `refund_approved` / `refund_denied` — admin processed a refund
- `admin_setting_changed` — admin modified a setting

All audit events include a `traceId` (UUID) for request correlation.

### Health Check

```
GET /health → { "ok": true, "version": "0.9.0" }
```

Returns `503` with `{ "ok": false }` if the database is unreachable. Use this for uptime monitoring and load balancer health probes.

### HTTP Access Logs

Morgan (`combined` format) logs every HTTP request to stdout.

---

## Testing

### Manual Testing Flow

#### 1. Health Check

```bash
curl http://localhost:3000/health
# Expected: {"ok":true,"version":"0.9.0"}
```

#### 2. Cancellation Form

Open `http://localhost:3000/cancel-order` in a browser (or via your Shopify store's App Proxy URL).

#### 3. Submit a Cancellation Request

```bash
# Via App Proxy (requires valid HMAC signature — test from your Shopify storefront)
# Or directly during development:
curl -X POST http://localhost:3000/proxy/request \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "email=customer@example.com&orderNumber=%231001&_csrf=<token>"
```

> **Note:** In production, the App Proxy signature is required. During local development, you can temporarily disable the signature check or use a test proxy URL from Shopify.

#### 4. Confirm Cancellation

Check the email for the confirmation link, or find the token in the database:

```bash
sqlite3 data/cancel-requests.db "SELECT * FROM cancel_requests ORDER BY created_at DESC LIMIT 1;"
```

#### 5. Admin Dashboard

```bash
# Open in browser
open http://localhost:3000/admin
# Login with your ADMIN_API_TOKEN

# Or use the API directly
curl http://localhost:3000/admin \
  -H "Authorization: Bearer <your-admin-token>"
```

#### 6. Admin Settings API

```bash
# Toggle auto-refund
curl -X POST http://localhost:3000/admin/api/settings \
  -H "Authorization: Bearer <your-admin-token>" \
  -H "Content-Type: application/json" \
  -d '{"key": "auto_refund", "value": "true"}'

# Update allowed fulfillment statuses
curl -X POST http://localhost:3000/admin/api/settings \
  -H "Authorization: Bearer <your-admin-token>" \
  -H "Content-Type: application/json" \
  -d '{"key": "allowed_fulfillment_statuses", "value": ["UNFULFILLED", "PARTIALLY_FULFILLED"]}'
```

#### 7. Webhook Testing (with Shopify CLI)

```bash
shopify app webhook trigger \
  --topic orders/cancelled \
  --address https://your-app.example.com/webhooks/orders/cancelled
```

### Linting

```bash
npm run lint
```

### CI Pipeline

The GitHub Actions CI runs on every push/PR to `main`:

1. **Matrix test** — Node.js 20 and 22
2. **Security audit** — `npm audit --audit-level=high`
3. **Linting** — ESLint with ES2022 rules

---

## Troubleshooting

### "Invalid App Proxy signature"

- Verify `SHOPIFY_APP_PROXY_SHARED_SECRET` matches the secret in your Shopify app settings
- Ensure you're accessing the form through the Shopify storefront URL (`/apps/order-cancel/...`), not directly

### "Invalid webhook signature"

- Verify `SHOPIFY_WEBHOOK_SECRET` matches the signing secret in your app's webhook settings
- Ensure the webhook URL matches your `APP_BASE_URL` exactly

### Emails not sending

- Check SMTP credentials in `.env`
- Verify your SMTP provider allows sending from the `EMAIL_FROM` address
- Check logs for email errors: `LOG_LEVEL=debug npm start`
- Failed emails are retried up to 5 times by the background queue (every 60 seconds)

### Rate limit issues

- If behind a proxy, set `TRUST_PROXY=1` so Express reads the real client IP
- Without `TRUST_PROXY`, all requests appear from the proxy IP, triggering rate limits immediately

### Admin dashboard won't load

- Ensure `ADMIN_API_TOKEN` is set and at least 16 characters
- If you get "Session IP mismatch", your IP may have changed — log in again
- Clear cookies if sessions are stale

### Database errors

- Ensure `DATA_DIR` exists and is writable
- Check available disk space
- The database uses WAL mode with a 5-second busy timeout for concurrent access

### Order not found / not cancelable

- Order must be within `ORDER_LOOKBACK_DAYS` (default 90 days)
- Order's fulfillment status must be in the allowed list (default: Unfulfilled)
- Order's financial status must be in the allowed list (default: Pending, Authorized, Paid)
- Order must not have fulfillment orders with status IN_PROGRESS, ON_HOLD, or INCOMPLETE

---

## License

Private — All rights reserved.
