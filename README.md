# Shopify Order Cancel Confirmation App

[![CI](https://github.com/pbm-spain/shopify-order-cancel-app/actions/workflows/ci.yml/badge.svg)](https://github.com/pbm-spain/shopify-order-cancel-app/actions/workflows/ci.yml)
[![Docker Publish](https://github.com/pbm-spain/shopify-order-cancel-app/actions/workflows/docker-publish.yml/badge.svg)](https://github.com/pbm-spain/shopify-order-cancel-app/actions/workflows/docker-publish.yml)

A self-hosted Shopify app that lets customers request order cancellations through a secure, email-confirmed workflow. The store owner retains full control over refund approvals via a built-in admin dashboard.

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

- [Prerequisites](#prerequisites)
- [Installation from Scratch](#installation-from-scratch)
  - [1. Clone the Repository](#1-clone-the-repository)
  - [2. Install Node.js Dependencies](#2-install-nodejs-dependencies)
  - [3. Configure Environment Variables](#3-configure-environment-variables)
  - [4. Start the Application](#4-start-the-application)
- [Shopify Partner Dashboard Setup](#shopify-partner-dashboard-setup)
  - [Step 1: Create a Shopify Partner Account](#step-1-create-a-shopify-partner-account)
  - [Step 2: Create a Custom App](#step-2-create-a-custom-app)
  - [Step 3: Configure API Scopes](#step-3-configure-api-scopes)
  - [Step 4: Get Your API Credentials](#step-4-get-your-api-credentials)
  - [Step 5: Configure the App Proxy](#step-5-configure-the-app-proxy)
  - [Step 6: Register Webhooks](#step-6-register-webhooks)
  - [Step 7: Install the App on Your Store](#step-7-install-the-app-on-your-store)
  - [Step 8: Link the Form in Your Storefront](#step-8-link-the-form-in-your-storefront)
- [Environment Variables Reference](#environment-variables-reference)
  - [Required Variables](#required-variables)
  - [Optional Variables](#optional-variables)
- [Architecture](#architecture)
  - [Project Structure](#project-structure)
  - [Tech Stack](#tech-stack)
  - [Database](#database)
  - [Data Flow](#data-flow)
  - [Key Design Decisions](#key-design-decisions)
- [API Endpoints Reference](#api-endpoints-reference)
  - [Customer-Facing Endpoints](#customer-facing-endpoints)
  - [Webhook Endpoints](#webhook-endpoints)
  - [Admin Endpoints](#admin-endpoints)
- [Admin Dashboard](#admin-dashboard)
- [Webhooks](#webhooks)
  - [Webhook Topics and Behavior](#webhook-topics-and-behavior)
  - [HMAC Verification](#hmac-verification)
  - [Deduplication and Idempotency](#deduplication-and-idempotency)
- [Email Configuration](#email-configuration)
- [Security](#security)
- [Testing](#testing)
  - [Running Automated Tests](#running-automated-tests)
  - [Manual Testing Flow](#manual-testing-flow)
  - [CI Pipeline](#ci-pipeline)
- [Deployment](#deployment)
  - [Docker (Recommended)](#docker-recommended)
  - [Railway / Render / Fly.io](#railway--render--flyio)
  - [VPS with Nginx](#vps-with-nginx)
  - [Process Management (systemd)](#process-management-systemd)
  - [Persistent Storage](#persistent-storage)
  - [Database Backups](#database-backups)
  - [Error Monitoring](#error-monitoring)
  - [Graceful Shutdown](#graceful-shutdown)
- [Monitoring & Logging](#monitoring--logging)
- [Troubleshooting](#troubleshooting)
- [License](#license)

---

## Prerequisites

Before you begin, make sure you have the following:

| Requirement | Details |
|---|---|
| **Node.js** | Version 20 or later (tested on 20 and 22). Download from [nodejs.org](https://nodejs.org/) |
| **npm** | Comes bundled with Node.js. Version 10+ recommended |
| **Git** | For cloning the repository |
| **Shopify Partner Account** | Free at [partners.shopify.com](https://partners.shopify.com/) |
| **A Shopify Store** | Development or production store where you'll install the app |
| **SMTP Provider** | Any provider that supports SMTP: [Resend](https://resend.com/), Mailgun, SendGrid, Amazon SES, Gmail SMTP, etc. |
| **HTTPS Endpoint** | Required by Shopify for App Proxy and webhooks. Use a reverse proxy (Nginx, Caddy) with Let's Encrypt, or a platform like Railway/Render that provides HTTPS automatically |
| **A domain or public URL** | Your app must be reachable from the internet for Shopify to communicate with it |

Optional:
- **Docker** (for containerized deployment)
- **SQLite CLI** (`sqlite3`) for manual database inspection during development

---

## Installation from Scratch

### 1. Clone the Repository

```bash
git clone https://github.com/pbm-spain/shopify-order-cancel-app.git
cd shopify-order-cancel-app
```

### 2. Install Node.js Dependencies

```bash
npm ci
```

This installs all production and development dependencies, including:

| Package | Purpose |
|---|---|
| `express` | HTTP server and routing |
| `better-sqlite3` | SQLite database driver (native module, compiled on install) |
| `nodemailer` | SMTP email sending |
| `dotenv` | Environment variable loading from `.env` |
| `cookie-parser` | Cookie parsing for sessions and CSRF |
| `morgan` | HTTP request logging |

> **Note:** `better-sqlite3` is a native C++ addon. On Linux, you may need `python3`, `make`, and `g++` installed. On macOS, Xcode Command Line Tools are required (`xcode-select --install`). On Docker/Alpine, the Dockerfile handles this automatically.

### 3. Configure Environment Variables

```bash
# Copy the example file
cp .env.example .env

# Generate a secure admin token (64-character hex string)
openssl rand -hex 32
```

Open `.env` in your editor and fill in all required values. See the [Environment Variables Reference](#environment-variables-reference) section for a complete description of each variable. At a minimum, you need:

1. Your Shopify API credentials (`SHOPIFY_ADMIN_ACCESS_TOKEN`, `SHOPIFY_STORE_DOMAIN`)
2. Your app's public URL (`APP_BASE_URL`)
3. Shopify security secrets (`SHOPIFY_APP_PROXY_SHARED_SECRET`, `SHOPIFY_WEBHOOK_SECRET`)
4. SMTP email settings (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM`)
5. Admin dashboard token (`ADMIN_API_TOKEN`) — paste the output from `openssl rand -hex 32`

### 4. Start the Application

```bash
# Production mode
npm start

# Development mode (auto-restarts on file changes)
npm run dev
```

The server starts on `http://localhost:3000` by default. Verify it's running:

```bash
curl http://localhost:3000/health
# Expected: {"ok":true,"version":"0.12.0"}
```

---

## Shopify Partner Dashboard Setup

This section walks you through the complete Shopify configuration, step by step.

### Step 1: Create a Shopify Partner Account

1. Go to [partners.shopify.com](https://partners.shopify.com/)
2. Sign up for a free Partner account (or log in if you already have one)
3. Once logged in, you'll land on the Partner Dashboard

### Step 2: Create a Custom App

1. In the Partner Dashboard, go to **Apps** in the left sidebar
2. Click **Create app**
3. Choose **Create app manually**
4. Fill in:
   - **App name**: e.g., `Order Cancel Confirmation`
   - **App URL**: Your public HTTPS URL (e.g., `https://cancel.mystore.com`)
   - **Allowed redirection URL(s)**: Add your callback URLs:
     ```
     https://cancel.mystore.com/auth/callback
     https://cancel.mystore.com/auth/shopify/callback
     https://cancel.mystore.com/api/auth/callback
     ```
5. Click **Create app**

After creation, you can also configure the `shopify.app.toml` file locally:

```bash
cp shopify.app.toml.example shopify.app.toml
```

Edit `shopify.app.toml` and replace `YOUR_APP_CLIENT_ID` with your app's Client ID from the Partner Dashboard.

### Step 3: Configure API Scopes

In your app's settings page (Partner Dashboard > Apps > Your App > Configuration):

Under **Access scopes**, request the following:

```
write_orders, read_orders
```

These scopes allow the app to:
- **`read_orders`**: Look up order details (customer email, fulfillment status, financial status)
- **`write_orders`**: Cancel orders, create refunds, add/remove tags

### Step 4: Get Your API Credentials

After installing the app on your store (Step 7), you'll be able to access the API credentials.

1. Go to **your Shopify store admin** > **Settings** > **Apps and sales channels** > **Develop apps** (or find your installed custom app)
2. Under **API credentials**, note the following:
   - **Admin API access token** (`shpat_...`): This is your `SHOPIFY_ADMIN_ACCESS_TOKEN`
   - **API secret key**: This is used for `SHOPIFY_WEBHOOK_SECRET`

Alternatively, if you're using the Partner Dashboard approach:
1. Go to **Apps** > **Your App** > **Client credentials**
2. Copy the **Client secret** — this will serve as your `SHOPIFY_APP_PROXY_SHARED_SECRET`
3. The webhook signing secret is separate — see Step 6

### Step 5: Configure the App Proxy

The App Proxy allows customers to access the cancellation form through your Shopify storefront URL (e.g., `https://your-store.myshopify.com/apps/order-cancel/cancel-order`), with Shopify handling HMAC signature verification.

1. In the Partner Dashboard, go to **Apps** > **Your App** > **App setup** (or **Configuration**)
2. Scroll down to **App Proxy**
3. Configure the following:

   | Field | Value |
   |---|---|
   | **Sub path prefix** | `apps` |
   | **Sub path** | `order-cancel` |
   | **Proxy URL** | `https://your-app.example.com/proxy` |

4. Save the configuration
5. Copy the **Shared secret** displayed on the App Proxy config — this is your `SHOPIFY_APP_PROXY_SHARED_SECRET` in `.env`

**How App Proxy works:**

When a customer visits `https://your-store.myshopify.com/apps/order-cancel/cancel-order`, Shopify proxies the request to your app at `https://your-app.example.com/proxy/cancel-order`, appending an HMAC signature to the query parameters. Your app verifies this signature to ensure the request genuinely came from Shopify.

**Signature verification details:**
- Shopify appends query parameters: `shop`, `path_prefix`, `timestamp`, `signature`
- The app sorts all parameters alphabetically (excluding `signature`), concatenates them, and computes HMAC-SHA256 using the shared secret
- Timing-safe comparison prevents timing attacks
- Array values in parameters are joined with commas per Shopify spec

### Step 6: Register Webhooks

Webhooks keep your app in sync when orders are modified outside the app (e.g., from the Shopify admin panel, another app, or the Shopify API).

1. In the Partner Dashboard, go to **Apps** > **Your App** > **Webhooks**
2. Register the following three webhooks:

   | Topic | Endpoint URL | Format |
   |---|---|---|
   | `orders/updated` | `https://your-app.example.com/webhooks/orders/updated` | JSON |
   | `orders/cancelled` | `https://your-app.example.com/webhooks/orders/cancelled` | JSON |
   | `refunds/create` | `https://your-app.example.com/webhooks/refunds/create` | JSON |

3. After saving, copy the **Webhook signing secret** — this is your `SHOPIFY_WEBHOOK_SECRET` in `.env`

> **Important:** All three webhook endpoints must be reachable via HTTPS. Shopify will send a test payload to verify they respond with `200 OK`.

**What each webhook does:**

| Webhook | Purpose |
|---|---|
| `orders/updated` | If an order with a pending cancellation changes to a non-allowed fulfillment status (e.g., it ships), the pending request is auto-denied |
| `orders/cancelled` | If an order is cancelled externally (e.g., from Shopify admin), the pending request is marked `cancelled_externally` |
| `refunds/create` | If a refund is created externally (e.g., from Shopify admin), the pending refund is marked as approved |

### Step 7: Install the App on Your Store

1. In the Partner Dashboard, go to **Apps** > **Your App**
2. Click **Select store** or use the distribution link
3. Choose your development or production store
4. Review the permissions (read/write orders) and click **Install app**
5. After installation, the Admin API access token becomes available

### Step 8: Link the Form in Your Storefront

Add a link to the cancellation form in your store's theme. The URL path depends on your App Proxy configuration.

**Option A: Simple link (footer, navigation, or dedicated page)**

```html
<a href="/apps/order-cancel/cancel-order">Cancel an Order</a>
```

**Option B: Pre-filled link on the order status page (using Liquid)**

```liquid
<a href="/apps/order-cancel/cancel-order?email={{ order.email }}&orderNumber={{ order.name }}">
  Request Cancellation
</a>
```

This pre-fills the customer's email and order number in the cancellation form, reducing friction.

**Where to add the link:**
- **Theme footer**: Online Store > Themes > Edit code > `footer.liquid` or the Footer section
- **Order status page**: Settings > Checkout > Order status page > Additional scripts
- **Navigation menu**: Online Store > Navigation > Add menu item with URL `/apps/order-cancel/cancel-order`
- **Dedicated page**: Online Store > Pages > Add page with HTML content

---

## Environment Variables Reference

All configuration is done via environment variables, loaded from a `.env` file. Copy `.env.example` to `.env` as a starting point.

### Required Variables

| Variable | Description | Example |
|---|---|---|
| `APP_BASE_URL` | The public HTTPS URL where your app is hosted. Used for generating confirmation email links. Must be a valid URL with protocol. | `https://cancel.mystore.com` |
| `SHOPIFY_STORE_DOMAIN` | Your store's `.myshopify.com` domain. Used to construct Shopify Admin API URLs. Do not include `https://`. | `my-store.myshopify.com` |
| `SHOPIFY_ADMIN_ACCESS_TOKEN` | Admin API access token from your installed Shopify app. Starts with `shpat_`. Used for all Shopify GraphQL API calls (order lookups, cancellations, refunds, tagging). | `shpat_xxxxxxxxxxxxxxxxxxxx` |
| `SHOPIFY_APP_PROXY_SHARED_SECRET` | The shared secret from your App Proxy configuration in the Partner Dashboard. Used to verify that incoming requests to `/proxy/*` genuinely come from Shopify. | (from Shopify Partners) |
| `SHOPIFY_WEBHOOK_SECRET` | The webhook signing secret from your app's webhook configuration. Used to verify HMAC-SHA256 signatures on all incoming webhook payloads. | (from Shopify Partners) |
| `SMTP_HOST` | Hostname of your SMTP server. | `smtp.resend.com` |
| `SMTP_PORT` | Port number for the SMTP server. Common values: `465` (SSL/TLS), `587` (STARTTLS), `25` (unencrypted). | `465` |
| `SMTP_USER` | Username for SMTP authentication. | `resend` |
| `SMTP_PASS` | Password or API key for SMTP authentication. | `re_xxxxxxxxxxxx` |
| `EMAIL_FROM` | The "From" address for cancellation confirmation emails. Can include a display name. Must be a verified sender with your SMTP provider. | `My Store <no-reply@mystore.com>` |
| `ADMIN_API_TOKEN` | Secret token for accessing the admin dashboard. Used for both browser login and Bearer token API authentication. Generate with `openssl rand -hex 32`. Must be at least 16 characters. | (use `openssl rand -hex 32`) |

### Optional Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Port the HTTP server listens on. Must be 1-65535. |
| `SHOPIFY_ADMIN_API_VERSION` | `2026-01` | Shopify Admin API version string. Only change this if you need a specific API version. |
| `SMTP_SECURE` | `true` | Whether to use TLS for the SMTP connection. Set to `false` for STARTTLS on port 587 or unencrypted on port 25. |
| `CANCEL_TOKEN_TTL_MINUTES` | `30` | How long (in minutes) the confirmation link in the email remains valid. After this time, the customer must submit a new request. |
| `CANCEL_NOTIFY_CUSTOMER` | `true` | Whether Shopify sends its own cancellation notification email to the customer (in addition to your app's email). Set to `false` to suppress Shopify's email. |
| `CANCEL_RESTOCK` | `true` | Whether to automatically restock inventory when an order is cancelled. |
| `CANCEL_REFUND` | `false` | Initial auto-refund setting. When `true`, cancellations automatically include a full refund. When `false`, orders are cancelled without refund and tagged `refund-pending` for admin review. This can be toggled at any time from the admin dashboard. |
| `ORDER_LOOKBACK_DAYS` | `90` | Only allow cancellation for orders placed within this many days. Orders older than this are rejected. |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Time window (in milliseconds) for the cancellation request rate limiter. |
| `RATE_LIMIT_MAX_REQUESTS` | `5` | Maximum number of cancellation requests allowed per IP address within the rate limit window. |
| `LOG_LEVEL` | `info` | Log verbosity. Options: `debug`, `info`, `warn`, `error`. The `audit` level is always logged regardless of this setting. |
| `DATA_DIR` | `./data` | Directory where the SQLite database file (`cancel-requests.db`) is stored. Must be writable by the app process. Use an absolute path in production. |
| `TRUST_PROXY` | `0` (disabled) | Set to `1` when running behind exactly one reverse proxy (Nginx, Caddy, Cloudflare). This tells Express to trust the `X-Forwarded-For` header for client IP detection, which is critical for rate limiting. Without this, all requests appear to come from the proxy's IP. **Do not enable if the app is directly exposed to the internet.** |
| `SENTRY_DSN` | (none) | Optional Sentry DSN for error monitoring. Requires installing `@sentry/node` (`npm install @sentry/node`). |
| `SENTRY_TRACES_SAMPLE_RATE` | `0.1` | Sentry performance monitoring sample rate (0.0 to 1.0). |
| `BACKUP_DIR` | `./data/backups` | Directory for database backup files (used by `scripts/backup-db.sh`). |
| `BACKUP_RETENTION_DAYS` | `30` | Number of days to retain database backups before auto-cleanup. |

---

## Architecture

### Project Structure

```
shopify-order-cancel-app/
├── src/
│   ├── server.js        # Entry point: HTTP server, background workers, graceful shutdown
│   ├── app.js           # Express app: routes, middleware, request handling
│   ├── config.js        # Environment variable loading with typed validation
│   ├── shopify.js       # Shopify Admin GraphQL API client (queries + mutations)
│   ├── storage.js       # SQLite database layer (better-sqlite3, WAL mode)
│   ├── appProxy.js      # Shopify App Proxy HMAC-SHA256 signature verification
│   ├── adminAuth.js     # Admin session auth, IP binding, CSRF tokens
│   ├── csrf.js          # CSRF protection for customer forms (double-submit cookies)
│   ├── email.js         # Nodemailer transport + confirmation email HTML template
│   ├── emailQueue.js    # Background email retry worker (exponential backoff, 5 retries)
│   ├── errorHandler.js  # Pluggable error monitoring (Sentry-ready, structured logging)
│   ├── rateLimit.js     # In-memory sliding window rate limiter (per IP and per email)
│   ├── logger.js        # Structured JSON logging + audit trail
│   ├── utils.js         # Token generation, SHA-256 hashing, input normalization
│   ├── views.js         # HTML rendering helpers (tables, badges, pagination)
│   └── webhooks.js      # Shopify webhook handlers (HMAC verification + event processing)
├── views/
│   ├── form.html        # Customer cancellation request form
│   ├── admin.html       # Admin dashboard (settings, pending refunds, history)
│   ├── success.html     # Cancellation confirmed page
│   └── request-sent.html # "Check your email" confirmation page
├── scripts/
│   └── backup-db.sh     # SQLite hot backup with compression and retention
├── tests/
│   ├── setup.js         # Test environment variables
│   ├── helpers.js       # HMAC generators, Shopify GraphQL mock fixtures
│   ├── cancel-flow.test.js    # Cancellation flow tests (P0/P1)
│   ├── refund-flow.test.js    # Refund approval/denial tests (P0/P1)
│   ├── admin-auth.test.js     # Admin authentication tests (P0/P1)
│   ├── webhook-hmac.test.js   # Webhook signature and dedup tests (P0/P1)
│   ├── views.test.js          # HTML rendering helpers tests (P2)
│   ├── error-handler.test.js  # Error monitoring tests (P2)
│   └── edge-cases.test.js     # Edge cases and storage atomicity tests (P2)
├── .github/workflows/
│   ├── ci.yml           # CI pipeline: lint, audit, test (Node 20/22)
│   └── docker-publish.yml # Multi-arch Docker build + push to GHCR
├── shopify.app.toml.example # Shopify app configuration template
├── Dockerfile           # Multi-stage production build (Node 20 Alpine)
├── docker-compose.yml   # Production + dev (with Mailpit SMTP) compose config
├── .env.example         # Environment variable template
└── package.json         # Dependencies and scripts
```

### Tech Stack

| Component | Technology |
|---|---|
| Runtime | Node.js 20+ (ES modules) |
| Web framework | Express 4.x |
| Database | SQLite via better-sqlite3 (WAL mode) |
| Email | Nodemailer 8.x |
| Shopify API | Admin GraphQL API (2026-01) |
| Testing | Vitest 4.x + supertest + MSW |
| CI/CD | GitHub Actions (Node 20/22 matrix, ESLint, npm audit, Vitest) |
| Container | Docker (Node 20 Alpine, multi-stage, multi-arch) |

### Database

The app uses a single SQLite database stored at `DATA_DIR/cancel-requests.db`. The database runs in WAL (Write-Ahead Logging) mode for concurrent read/write access, with a 5-second busy timeout.

**Tables:**

| Table | Purpose | Key Columns |
|---|---|---|
| `cancel_requests` | Stores every cancellation request | `id` (UUID), `order_id` (GraphQL GID), `email`, `token_hash` (SHA-256), `status` (pending/cancelled/denied/error/cancelled_externally), `refund_status` (none/automatic/pending/approved/denied/error), `used_at`, `created_at` |
| `admin_settings` | Key-value store for admin-configurable settings | `key`, `value`, `updated_at` |
| `webhook_events` | Webhook deduplication log | `webhook_id` (PRIMARY KEY), `received_at` |

The database is created automatically on first startup. All tables and indexes are created via `CREATE TABLE IF NOT EXISTS` statements.

### Data Flow

1. **Request phase:** Customer submits the cancellation form → App Proxy HMAC signature is verified → Order is looked up via Shopify GraphQL API → Eligibility is checked (fulfillment status, financial status, age) → A 256-bit random token is generated → Token is SHA-256 hashed and stored in the database → Confirmation email is sent with the raw token in the link
2. **Confirmation phase:** Customer clicks the link → Token is validated against the hash in the database → Order is re-verified with Shopify (still exists, still cancelable) → `orderCancel` mutation is sent to Shopify (returns an async Job) → Database record is updated
3. **Refund phase (if auto-refund is OFF):** Order is tagged `refund-pending` in Shopify → Admin sees it in the dashboard → Admin approves or denies → On approval: refund is created via `refundCreate` GraphQL mutation with an idempotency key → `refund-pending` tag is removed

### Key Design Decisions

- **Async cancellation:** Shopify's `orderCancel` mutation returns a Job ID, not an immediate result. The app relies on the `orders/cancelled` webhook to detect completion rather than polling the Job.
- **Token hashing:** Confirmation tokens are stored as SHA-256 hashes in the database. The raw token only exists in the email link and in memory during generation. This means even a database breach doesn't expose usable tokens.
- **Atomic operations:** Token usage and refund approvals use SQL `WHERE ... IS NULL` / `WHERE ... = expected_status` patterns to prevent race conditions (double-clicks, concurrent requests).
- **Idempotent refunds:** The `refundCreate` mutation uses a deterministic idempotency key derived from the request ID, preventing duplicate refunds.
- **Webhook deduplication:** Each webhook event is tracked by its `X-Shopify-Webhook-Id` header. Duplicate deliveries are silently ignored via `INSERT ... ON CONFLICT DO NOTHING`.
- **REST-to-GraphQL ID translation:** Webhooks deliver REST API payloads with numeric order IDs, but the database stores GraphQL GIDs (`gid://shopify/Order/{id}`). The app translates between formats automatically.

---

## API Endpoints Reference

### Customer-Facing Endpoints

| Method | Path | Auth | Rate Limit | Description |
|---|---|---|---|---|
| `GET` | `/health` | None | None | Health check. Returns `{"ok":true,"version":"0.12.0"}`. Returns `503` if database is unreachable. |
| `GET` | `/cancel-order` | None | None | Serves the cancellation request form (HTML). |
| `POST` | `/proxy/request` | App Proxy HMAC + CSRF | 5/min per IP, 3/hr per email | Submits a cancellation request. Validates the order, generates a token, and sends a confirmation email. |
| `GET` | `/confirm?token=<token>` | Token in URL | 30/hr per IP | Confirms a cancellation from the email link. Validates the token, checks the order, and sends the cancel mutation to Shopify. |

### Webhook Endpoints

All webhook endpoints verify HMAC-SHA256 signatures using the raw request body and the `SHOPIFY_WEBHOOK_SECRET`. They always return `200 OK` to prevent Shopify from retrying indefinitely.

| Method | Path | Shopify Topic | Description |
|---|---|---|---|
| `POST` | `/webhooks/orders/updated` | `orders/updated` | Auto-denies pending cancellation requests if the order ships or moves to a non-allowed fulfillment status. |
| `POST` | `/webhooks/orders/cancelled` | `orders/cancelled` | Marks pending requests as `cancelled_externally` when an order is cancelled outside the app. |
| `POST` | `/webhooks/refunds/create` | `refunds/create` | Marks pending refunds as approved when a refund is created outside the app. |

### Admin Endpoints

All admin endpoints require authentication: either a server-side session cookie (from browser login) or a `Authorization: Bearer <ADMIN_API_TOKEN>` header.

| Method | Path | CSRF | Rate Limit | Description |
|---|---|---|---|---|
| `POST` | `/admin/login` | No | 5 attempts/15 min per IP | Authenticates with the admin token. Sets a session cookie with IP binding. |
| `GET` | `/admin/logout` | No | None | Clears the session and redirects to login. |
| `GET` | `/admin` | No | None | Renders the admin dashboard HTML (settings, pending refunds, cancellation history). |
| `POST` | `/admin/api/settings` | Yes | 20/min per IP | Updates a setting. JSON body: `{"key": "...", "value": "..."}`. |
| `POST` | `/admin/refund/approve` | Yes | None | Approves a pending refund. Creates the refund in Shopify and removes the `refund-pending` tag. |
| `POST` | `/admin/refund/deny` | Yes | None | Denies a pending refund. Updates the status without creating a Shopify refund. |

---

## Admin Dashboard

Access the dashboard at `https://your-app.example.com/admin`. Log in with the value you set for `ADMIN_API_TOKEN`.

### Settings Panel

- **Auto-refund toggle:** When ON, cancellations automatically include a full refund. When OFF, orders are cancelled without refund and tagged `refund-pending` for manual review.
- **Allowed fulfillment statuses:** Select which Shopify fulfillment statuses allow cancellation. Options include: Unfulfilled, Partially Fulfilled, Scheduled, On Hold. By default, only `UNFULFILLED` is allowed.
- **Allowed financial statuses:** Select which Shopify financial statuses allow cancellation. Options include: Pending, Authorized, Paid, Partially Paid, Partially Refunded. By default: `PENDING`, `AUTHORIZED`, `PAID`.

Settings are persisted in the SQLite database and take effect immediately. All changes are logged in the audit trail.

### Pending Refunds Table

When auto-refund is OFF, pending refunds appear in a paginated table (25 per page). Each row shows:
- Order number (linked to Shopify admin)
- Customer email
- Cancellation date
- **Approve** / **Deny** buttons

Approving a refund:
1. Verifies the order is still cancelled in Shopify
2. Atomically transitions the refund status from `pending` to `approved` (prevents double-approval)
3. Creates the refund via the Shopify GraphQL `refundCreate` mutation with an idempotency key
4. Removes the `refund-pending` tag from the order in Shopify

### Recent Cancellations Table

A paginated table of all processed cancellations with their refund status badge: **Automatic**, **Approved**, **Denied**, **Pending**, **Error**.

---

## Webhooks

### Webhook Topics and Behavior

| Webhook | Trigger | App Behavior |
|---|---|---|
| `orders/updated` | Any change to an order (fulfillment, financial status, tags, etc.) | If an order with a `pending` cancellation request changes to a non-allowed fulfillment status (e.g., it ships), the pending request is automatically denied. |
| `orders/cancelled` | An order is cancelled from any source (Shopify admin, API, another app) | If the order had a pending cancellation request in the app, it is marked as `cancelled_externally`. This prevents the customer from confirming an already-cancelled order. |
| `refunds/create` | A refund is created from any source | If the order had a pending refund (`refund-pending` status), it is marked as `approved`. This syncs external refunds made directly in Shopify. |

### HMAC Verification

Every incoming webhook is verified before processing:

1. The raw request body is read (before JSON parsing)
2. HMAC-SHA256 is computed using `SHOPIFY_WEBHOOK_SECRET` as the key
3. The computed hash is compared against the `X-Shopify-Hmac-Sha256` header using `crypto.timingSafeEqual`
4. Requests with invalid signatures are rejected with `401 Unauthorized`

### Deduplication and Idempotency

Shopify may deliver the same webhook multiple times (network retries, at-least-once delivery). The app handles this:

1. Each webhook has a unique `X-Shopify-Webhook-Id` header
2. On receipt, the app attempts to insert the ID into the `webhook_events` table
3. If the ID already exists (`ON CONFLICT DO NOTHING`), the webhook is silently skipped
4. Old webhook events (>30 days) are automatically cleaned up by a background worker

All webhook handlers return `200 OK` regardless of processing outcome. This prevents Shopify from retrying indefinitely on application errors.

---

## Email Configuration

The app sends confirmation emails via SMTP using Nodemailer. You need an SMTP provider that allows sending from your configured `EMAIL_FROM` address.

### Common SMTP Provider Settings

| Provider | `SMTP_HOST` | `SMTP_PORT` | `SMTP_SECURE` | `SMTP_USER` | `SMTP_PASS` |
|---|---|---|---|---|---|
| **Resend** | `smtp.resend.com` | `465` | `true` | `resend` | Your API key (`re_...`) |
| **SendGrid** | `smtp.sendgrid.net` | `465` | `true` | `apikey` | Your API key (`SG...`) |
| **Mailgun** | `smtp.mailgun.org` | `465` | `true` | Your Mailgun SMTP user | Your Mailgun SMTP password |
| **Amazon SES** | `email-smtp.<region>.amazonaws.com` | `465` | `true` | Your SES SMTP user | Your SES SMTP password |
| **Gmail** | `smtp.gmail.com` | `465` | `true` | Your Gmail address | App password (not your regular password) |

### Email Retry Queue

Failed email sends are automatically retried by a background worker:

- Retries up to **5 times** with exponential backoff
- Retry intervals: ~60s, ~120s, ~240s, ~480s, ~960s
- The worker runs every **60 seconds** checking for failed emails
- All failures are logged with full error details

### Development: Local Email Testing with Mailpit

For local development, you can use Mailpit to catch all outgoing emails without sending them:

```bash
# Start the app with Mailpit using Docker Compose
docker compose --profile dev up -d

# Mailpit Web UI (view caught emails): http://localhost:8025
# Mailpit SMTP: localhost:1025
```

Set these in your `.env` for local development:
```
SMTP_HOST=localhost
SMTP_PORT=1025
SMTP_SECURE=false
SMTP_USER=test
SMTP_PASS=test
```

---

## Security

### Authentication & Authorization

| Layer | Mechanism |
|---|---|
| App Proxy (customer requests) | HMAC-SHA256 signature verification using Shopify's shared secret |
| Webhooks | HMAC-SHA256 signature verification using the webhook signing secret |
| Admin dashboard (browser) | Opaque server-side session tokens with IP binding (8-hour TTL) |
| Admin API (programmatic) | Bearer token authentication (`Authorization: Bearer <token>`) |

### CSRF Protection

- **Customer forms:** Double-submit cookie pattern. A random token is set in a cookie and included as a hidden form field. Both must match on submission.
- **Admin panel:** Session-based CSRF tokens. One token per session, verified with `crypto.timingSafeEqual`.

### Rate Limiting

| Endpoint | Limit | Window | Key |
|---|---|---|---|
| `POST /proxy/request` | 5 requests | 1 minute | Per IP address |
| `POST /proxy/request` | 3 requests | 1 hour | Per email address |
| `GET /confirm` | 30 requests | 1 hour | Per IP address |
| `POST /admin/login` | 5 attempts | 15 minutes | Per IP address |
| `POST /admin/api/settings` | 20 requests | 1 minute | Per IP address |

Rate limiting uses an in-memory sliding window implementation. Counters are not persisted and reset on app restart.

### Token Security

- Confirmation tokens are 64-character hex strings (256-bit entropy, generated with `crypto.randomBytes`)
- Tokens are hashed with SHA-256 before database storage — raw tokens never touch the database
- Tokens are single-use: atomic `WHERE used_at IS NULL` check prevents reuse
- Tokens expire after `CANCEL_TOKEN_TTL_MINUTES` (default: 30 minutes)

### HTTP Security Headers

Every response includes:

```
Content-Security-Policy: default-src 'self'; script-src 'self' 'nonce-<random>'; style-src 'self' 'nonce-<random>';
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Referrer-Policy: strict-origin-when-cross-origin
Strict-Transport-Security: max-age=31536000; includeSubDomains  (only over HTTPS)
```

CSP nonces are randomly generated per request and injected into all `<style>` and `<script>` tags.

### Additional Protections

- All sensitive comparisons (HMAC, tokens, passwords) use `crypto.timingSafeEqual` to prevent timing attacks
- SQL injection prevention via prepared statements (better-sqlite3 parameterized queries)
- Input validation on all user inputs: email format regex, order number regex (`#\d+`), UUID format validation
- Open redirect protection on admin login (redirect URLs are validated)
- Content-Type validation: returns `415 Unsupported Media Type` for unexpected content types
- Request body size limit: 10KB maximum
- Admin session IP binding: sessions are invalidated if the client IP changes (protects against session fixation)
- `TRUST_PROXY` must be explicitly enabled — prevents `X-Forwarded-For` header spoofing that would bypass IP-based rate limits

---

## Testing

### Running Automated Tests

```bash
# Run all tests
npm test

# Run tests in watch mode (re-runs on file changes)
npm run test:watch

# Generate a coverage report
npm run test:coverage

# Run linting
npm run lint
```

The test suite uses **Vitest** as the test runner, **supertest** for HTTP integration testing, and **MSW** (Mock Service Worker) for mocking Shopify GraphQL API responses.

### Test Suites

| Suite | File | Priority | What It Tests |
|---|---|---|---|
| Cancel Flow | `cancel-flow.test.js` | P0/P1 | Form CSRF validation, App Proxy HMAC verification, input validation, full cancellation flow, duplicate request prevention |
| Refund Flow | `refund-flow.test.js` | P0/P1 | Refund approval/denial, atomic state transitions, webhook-driven sync, idempotency |
| Admin Auth | `admin-auth.test.js` | P0/P1 | Bearer token auth, session auth, login/logout flow, rate limiting, open redirect prevention |
| Webhook HMAC | `webhook-hmac.test.js` | P0/P1 | HMAC signature verification, deduplication, timing safety, all three webhook handlers |
| Views | `views.test.js` | P2 | HTML rendering helpers (table generation, status badges, pagination, XSS prevention) |
| Error Handler | `error-handler.test.js` | P2 | Error capture, Express error middleware, Sentry integration |
| Edge Cases | `edge-cases.test.js` | P2 | Token expiry/reuse, admin pagination, settings validation, storage atomicity |

### Manual Testing Flow

#### 1. Verify the app is running

```bash
curl http://localhost:3000/health
# Expected: {"ok":true,"version":"0.12.0"}
```

#### 2. Open the cancellation form

Navigate to `http://localhost:3000/cancel-order` in a browser (or via your Shopify store's App Proxy URL at `https://your-store.myshopify.com/apps/order-cancel/cancel-order`).

#### 3. Submit a cancellation request

Through the form in the browser, or via curl:

```bash
curl -X POST http://localhost:3000/proxy/request \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "email=customer@example.com&orderNumber=%231001&_csrf=<token>"
```

> In production, the App Proxy HMAC signature is required. During local development, requests must come through the Shopify storefront or the signature check must be accounted for.

#### 4. Confirm the cancellation

Check the email for the confirmation link. If using Mailpit locally, visit `http://localhost:8025`. You can also find the token hash in the database:

```bash
sqlite3 data/cancel-requests.db "SELECT * FROM cancel_requests ORDER BY created_at DESC LIMIT 1;"
```

#### 5. Access the admin dashboard

```bash
# In a browser
open http://localhost:3000/admin
# Login with your ADMIN_API_TOKEN value

# Or via API with Bearer token
curl http://localhost:3000/admin \
  -H "Authorization: Bearer <your-admin-token>"
```

#### 6. Test admin settings API

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

#### 7. Test webhooks with Shopify CLI

```bash
shopify app webhook trigger \
  --topic orders/cancelled \
  --address https://your-app.example.com/webhooks/orders/cancelled
```

### CI Pipeline

The GitHub Actions CI runs on every push and pull request to `main`:

1. **Matrix test** — Runs on Node.js 20 and 22
2. **Security audit** — `npm audit --audit-level=high` (fails on high/critical vulnerabilities)
3. **Linting** — ESLint with ES2022 rules
4. **Tests** — Full Vitest suite

### Docker Publish Pipeline

On every push to `main`, the Docker Publish workflow:

1. Builds a multi-platform image (`linux/amd64` + `linux/arm64`)
2. Pushes to `ghcr.io/pbm-spain/shopify-order-cancel-app` with tags: `latest` and `sha-<commit>`
3. Uses GitHub Actions layer caching for faster builds

---

## Deployment

### Docker (Recommended)

#### Option A: Pre-built image from GitHub Container Registry

The image is automatically built and published on every push to `main` for both `linux/amd64` and `linux/arm64`.

```bash
# Pull the latest image
docker pull ghcr.io/pbm-spain/shopify-order-cancel-app:latest

# Run with an env file and persistent volume
docker run -d \
  --name shopify-cancel-app \
  --env-file .env \
  -e NODE_ENV=production \
  -e DATA_DIR=/app/data \
  -v cancel-app-data:/app/data \
  -p 3000:3000 \
  --restart unless-stopped \
  ghcr.io/pbm-spain/shopify-order-cancel-app:latest
```

Or use the pre-built image in `docker-compose.yml`:

```yaml
services:
  app:
    image: ghcr.io/pbm-spain/shopify-order-cancel-app:latest
    ports:
      - "3000:3000"
    env_file:
      - .env
    environment:
      - NODE_ENV=production
      - DATA_DIR=/app/data
    volumes:
      - app-data:/app/data
    restart: unless-stopped

volumes:
  app-data:
```

#### Option B: Build locally

```bash
# Production build and run
docker compose up -d

# Development with local Mailpit SMTP (catches all outgoing email)
docker compose --profile dev up -d
# Mailpit web UI: http://localhost:8025
# SMTP endpoint: localhost:1025
```

The Dockerfile uses a multi-stage build:
1. **Stage 1 (deps):** Installs build tools (`python3`, `make`, `g++`) and production dependencies on Node 20 Alpine
2. **Stage 2 (production):** Copies only production dependencies and app source, runs as non-root user (`appuser:appgroup`), includes health check

#### Option C: Pull a specific version

```bash
docker pull ghcr.io/pbm-spain/shopify-order-cancel-app:sha-<full-commit-sha>
```

### Railway / Render / Fly.io

1. Connect your GitHub repository
2. Set all environment variables from [Environment Variables Reference](#environment-variables-reference)
3. Set the build command to `npm ci`
4. Set the start command to `npm start`
5. Ensure `DATA_DIR` points to a persistent volume (e.g., `/data`)
6. Configure health check to `GET /health`
7. Set the `PORT` environment variable if the platform requires it (some auto-assign)

### VPS with Nginx

Example Nginx reverse proxy configuration with SSL (Let's Encrypt):

```nginx
server {
    listen 443 ssl http2;
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

# Redirect HTTP to HTTPS
server {
    listen 80;
    server_name cancel.mystore.com;
    return 301 https://$server_name$request_uri;
}
```

> **Important:** When behind a reverse proxy, set `TRUST_PROXY=1` in your `.env`. Without this, all rate limits see the proxy's IP instead of the real client IP.

### Process Management (systemd)

Create `/etc/systemd/system/shopify-cancel-app.service`:

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

Then enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable shopify-cancel-app
sudo systemctl start shopify-cancel-app
sudo systemctl status shopify-cancel-app
```

### Persistent Storage

The SQLite database is stored at `DATA_DIR/cancel-requests.db`. This directory must:

- Be on persistent storage (not ephemeral container filesystem)
- Have read/write permissions for the app process
- Have sufficient disk space (the database grows slowly, typically under 100MB even for high-volume stores)
- Be backed up regularly (see [Database Backups](#database-backups))

### Database Backups

The included backup script creates consistent, hot backups without stopping the app:

```bash
# Manual backup
npm run backup

# With custom settings
DATA_DIR=/app/data BACKUP_DIR=/mnt/backups BACKUP_RETENTION_DAYS=14 ./scripts/backup-db.sh

# Automated daily backup via cron (at 03:00)
0 3 * * * cd /opt/shopify-cancel-app && ./scripts/backup-db.sh >> /var/log/cancel-app-backup.log 2>&1
```

The script:
1. Uses SQLite's `VACUUM INTO` for a consistent point-in-time snapshot (safe with WAL mode)
2. Compresses the backup with gzip
3. Verifies backup integrity
4. Auto-deletes backups older than `BACKUP_RETENTION_DAYS` (default: 30)

### Error Monitoring

The app includes a pluggable error monitoring integration. Without any configuration, all errors are captured via structured JSON logging.

To enable Sentry:

```bash
npm install @sentry/node
```

Add to `.env`:
```
SENTRY_DSN=https://examplePublicKey@o0.ingest.sentry.io/0
SENTRY_TRACES_SAMPLE_RATE=0.1
```

The integration automatically:
- Scrubs sensitive headers (`Authorization`, `Cookie`) before sending to external services
- Catches unhandled promise rejections and uncaught exceptions
- Provides Express error-handling middleware for route errors

### Graceful Shutdown

The app handles `SIGINT` and `SIGTERM` signals cleanly:

1. Stops accepting new connections
2. Waits for in-flight requests to complete (10-second timeout)
3. Stops background workers (email retry queue, session cleanup, webhook cleanup)
4. Optimizes and closes the SQLite database (WAL checkpoint)
5. Exits with code 0

This ensures zero data loss during deployments and container restarts.

---

## Monitoring & Logging

### Structured Logging

All logs are JSON-formatted to stdout/stderr, compatible with any log aggregation service (Datadog, CloudWatch, ELK, Loki, Grafana, etc.):

```json
{"timestamp":"2026-03-30T10:00:00.000Z","level":"info","message":"Order cancelled successfully","orderId":"gid://shopify/Order/123","jobId":"gid://shopify/Job/456","withRefund":false}
```

### Log Levels

| Level | Content |
|---|---|
| `debug` | GraphQL error details, webhook skip reasons, detailed flow tracing |
| `info` | Order searches, cancellations, refunds, email sends, settings changes |
| `warn` | Invalid HMAC signatures, failed email sends, parse errors, skipped webhooks |
| `error` | Shopify API errors, unhandled failures, database errors, health check failures |
| `audit` | Always logged regardless of `LOG_LEVEL` — security-sensitive events (see below) |

### Audit Trail

Security-sensitive events are always logged at `audit` level with structured data:

| Event | Description |
|---|---|
| `cancel_requested` | Customer submitted a cancellation request |
| `cancel_confirmed` | Customer confirmed a cancellation via the email link |
| `cancel_confirmed_refund_pending` | Customer confirmed, but refund is pending admin review |
| `refund_approved` | Admin approved a pending refund |
| `refund_denied` | Admin denied a pending refund |
| `admin_setting_changed` | Admin modified a setting |

All audit events include a `traceId` (UUID) for request correlation across log entries.

### Health Check

```
GET /health → {"ok":true,"version":"0.12.0"}
```

Returns `503 Service Unavailable` with `{"ok":false}` if the database is unreachable. Use this endpoint for:
- Uptime monitoring (Pingdom, UptimeRobot, etc.)
- Load balancer health probes
- Docker/Kubernetes health checks
- Platform readiness checks (Railway, Render, etc.)

### HTTP Access Logs

Morgan (`combined` format) logs every HTTP request to stdout, including method, path, status code, response time, and user agent.

---

## Troubleshooting

### "Invalid App Proxy signature"

- Verify `SHOPIFY_APP_PROXY_SHARED_SECRET` matches the secret in your Shopify app's App Proxy settings
- Ensure you're accessing the form through the Shopify storefront URL (`https://your-store.myshopify.com/apps/order-cancel/...`), not directly hitting your server
- The signature is only valid for requests proxied through Shopify

### "Invalid webhook signature"

- Verify `SHOPIFY_WEBHOOK_SECRET` matches the signing secret in your app's webhook settings (Partner Dashboard or store admin)
- Ensure the webhook endpoint URL matches your `APP_BASE_URL` exactly (including protocol and path)
- Check that no middleware is modifying the raw request body before signature verification

### Emails not sending

- Check SMTP credentials in `.env` (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`)
- Verify your SMTP provider allows sending from the `EMAIL_FROM` address (sender verification/domain authentication may be required)
- Check logs for email errors: `LOG_LEVEL=debug npm start`
- Failed emails are retried up to 5 times by the background queue (check logs for retry attempts)
- For local testing, use Mailpit: `docker compose --profile dev up -d` and check `http://localhost:8025`

### Rate limit issues

- If behind a proxy, set `TRUST_PROXY=1` so Express reads the real client IP from `X-Forwarded-For`
- Without `TRUST_PROXY`, all requests appear from the proxy's IP, triggering rate limits immediately
- Rate limit counters reset on app restart (they are in-memory only)

### Admin dashboard won't load

- Ensure `ADMIN_API_TOKEN` is set in `.env` and is at least 16 characters
- If you get "Session IP mismatch", your IP may have changed — log in again
- Clear browser cookies if sessions are stale
- Check that you're using the correct token value (no extra whitespace)

### Database errors

- Ensure `DATA_DIR` exists and is writable by the app process: `mkdir -p data && chmod 755 data`
- Check available disk space: `df -h`
- The database uses WAL mode with a 5-second busy timeout — high concurrency is generally not an issue for single-instance deployments
- If the database is corrupted, restore from a backup and check disk health

### Order not found / not cancelable

- Order must be within `ORDER_LOOKBACK_DAYS` (default: 90 days from order creation)
- Order's fulfillment status must be in the allowed list (default: `UNFULFILLED`)
- Order's financial status must be in the allowed list (default: `PENDING`, `AUTHORIZED`, `PAID`)
- Order must not have fulfillment orders with status `IN_PROGRESS`, `ON_HOLD`, or `INCOMPLETE`
- Check the admin dashboard settings to see current allowed statuses

### Connection issues

- Verify your `APP_BASE_URL` is reachable from the internet (Shopify needs to reach it for App Proxy and webhooks)
- Check firewall rules allow inbound traffic on your configured port
- For HTTPS, verify your SSL certificate is valid and not expired
- Check DNS resolution for your domain

---

## License

Private — All rights reserved.
