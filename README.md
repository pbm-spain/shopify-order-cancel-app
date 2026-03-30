# Shopify Order Cancel Confirmation App

[![CI](https://github.com/pbm-spain/shopify-order-cancel-app/actions/workflows/ci.yml/badge.svg)](https://github.com/pbm-spain/shopify-order-cancel-app/actions/workflows/ci.yml)
[![Docker Publish](https://github.com/pbm-spain/shopify-order-cancel-app/actions/workflows/docker-publish.yml/badge.svg)](https://github.com/pbm-spain/shopify-order-cancel-app/actions/workflows/docker-publish.yml)

A self-hosted Shopify app that lets customers request order cancellations through a secure, email-confirmed workflow. The store owner retains full control over refund approvals via a built-in admin dashboard.

---

## Table of Contents

- [Overview](#overview)
- [Prerequisites](#prerequisites)
- [Shopify Setup (from Scratch)](#shopify-setup-from-scratch)
  - [1. Create a Shopify Partner Account](#1-create-a-shopify-partner-account)
  - [2. Create a Custom App](#2-create-a-custom-app)
  - [3. Configure API Scopes](#3-configure-api-scopes)
  - [4. Get Your API Credentials](#4-get-your-api-credentials)
  - [5. Configure the App Proxy](#5-configure-the-app-proxy)
  - [6. Register Webhooks](#6-register-webhooks)
  - [7. Configure Admin Link Extension](#7-configure-admin-link-extension)
  - [8. Install the App on Your Store](#8-install-the-app-on-your-store)
  - [9. Link the Form in Your Storefront](#9-link-the-form-in-your-storefront)
- [Environment Variables](#environment-variables)
  - [Required Variables](#required-variables)
  - [Optional Variables](#optional-variables)
- [Installation and Running](#installation-and-running)
  - [With Docker (Recommended)](#with-docker-recommended)
  - [Without Docker (Development)](#without-docker-development)
- [API Endpoints Reference](#api-endpoints-reference)
  - [Health Check](#health-check)
  - [Customer-Facing Endpoints](#customer-facing-endpoints)
  - [Webhook Endpoints](#webhook-endpoints)
  - [Admin Endpoints](#admin-endpoints)
- [Admin Dashboard](#admin-dashboard)
- [Database](#database)
  - [Tables](#tables)
  - [Storage Location](#storage-location)
  - [Backup Strategy](#backup-strategy)
- [Docker Operations](#docker-operations)
  - [Running Backups](#running-backups)
  - [Inspecting the Database](#inspecting-the-database)
  - [Viewing Logs](#viewing-logs)
  - [Health Check](#health-check-1)
  - [Using the Backup Script](#using-the-backup-script)
  - [Accessing a Shell Inside the Container](#accessing-a-shell-inside-the-container)
  - [Updating the Application](#updating-the-application)
- [Testing](#testing)
  - [Running Automated Tests](#running-automated-tests)
  - [Test Suites](#test-suites)
- [CI/CD](#cicd)
  - [CI Pipeline](#ci-pipeline)
  - [Docker Publish Pipeline](#docker-publish-pipeline)
- [Security](#security)
  - [Authentication and Authorization](#authentication-and-authorization)
  - [CSRF Protection](#csrf-protection)
  - [Rate Limiting](#rate-limiting)
  - [Token Security](#token-security)
  - [HTTP Security Headers](#http-security-headers)
  - [Additional Protections](#additional-protections)
- [Troubleshooting](#troubleshooting)
- [License](#license)

---

## Overview

This application provides a complete order cancellation workflow for Shopify stores. Customers fill out a form, receive a confirmation email with a time-limited link, and upon confirmation, the order is cancelled in Shopify. The store owner can choose between automatic refunds or manual approval through an admin dashboard.

### Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                      SHOPIFY STOREFRONT                         │
│                                                                  │
│  Customer visits /apps/order-cancel/cancel-order                 │
│         │                                                        │
│         ▼  (App Proxy with HMAC signature)                       │
└─────────┬────────────────────────────────────────────────────────┘
          │
          ▼
┌──────────────────────────────────────────────────────────────────┐
│                    YOUR SERVER (Docker)                           │
│                                                                  │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────────────┐  │
│  │  Express     │  │  SQLite DB   │  │  Background Workers    │  │
│  │  App         │  │  (WAL mode)  │  │  - Email retry queue   │  │
│  │             │  │              │  │  - Webhook cleanup     │  │
│  │  Routes:    │  │  Tables:     │  │  - Session cleanup     │  │
│  │  /proxy/*   │  │  cancel_req  │  │                        │  │
│  │  /confirm   │  │  admin_sets  │  └────────────────────────┘  │
│  │  /webhooks/*│  │  webhook_evt │                               │
│  │  /admin/*   │  │              │  ┌────────────────────────┐  │
│  │  /health    │  │  File:       │  │  Nodemailer            │  │
│  │             │  │  /app/data/  │  │  (SMTP transport)      │  │
│  │             │  │  cancel-     │  │                        │  │
│  │             │  │  requests.db │  └────────────────────────┘  │
│  └─────────────┘  └──────────────┘                               │
└──────────┬───────────────────────────────────────────────────────┘
           │
           ▼  (GraphQL API)
┌──────────────────────────────────────────────────────────────────┐
│                    SHOPIFY ADMIN API                              │
│                                                                  │
│  - Order lookup (fulfillment status, financial status)           │
│  - orderCancel mutation (async Job)                              │
│  - refundCreate mutation (with idempotency key)                  │
│  - tagsAdd / tagsRemove (refund-pending tag)                     │
│                                                                  │
│  Webhooks (push to your server):                                 │
│  - orders/updated     → auto-deny if order ships                 │
│  - orders/cancelled   → mark as cancelled_externally             │
│  - refunds/create     → mark pending refund as approved          │
└──────────────────────────────────────────────────────────────────┘
```

### How It Works

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
- Self-contained Docker image with SQLite, backup tools, and health checks

---

## Prerequisites

| Requirement | Details |
|---|---|
| **Docker and Docker Compose** | Required for the recommended deployment method. Install from [docs.docker.com](https://docs.docker.com/get-docker/) |
| **Shopify Partner Account** | Free at [partners.shopify.com](https://partners.shopify.com/) |
| **A Shopify Store** | Development or production store where you will install the app |
| **SMTP Provider** | Any provider that supports SMTP: [Resend](https://resend.com/), Mailgun, SendGrid, Amazon SES, Gmail SMTP, etc. |
| **HTTPS Endpoint** | Required by Shopify for App Proxy and webhooks. Use a reverse proxy (Nginx, Caddy) with Let's Encrypt, or a platform like Railway/Render that provides HTTPS automatically |
| **A domain or public URL** | Your app must be reachable from the internet for Shopify to communicate with it |

For development without Docker:
- **Node.js** version 20 or later (tested on 20 and 22). Download from [nodejs.org](https://nodejs.org/)
- **npm** (bundled with Node.js, version 10+ recommended)
- **Git** for cloning the repository

---

## Shopify Setup (from Scratch)

This section walks you through the complete Shopify configuration from zero. Complete all steps before running the app.

### 1. Create a Shopify Partner Account

1. Go to [partners.shopify.com](https://partners.shopify.com/)
2. Sign up for a free Partner account (or log in if you already have one)
3. Once logged in, you land on the Partner Dashboard

### 2. Create a Custom App

1. In the Partner Dashboard, go to **Apps** in the left sidebar
2. Click **Create app**
3. Choose **Create app manually**
4. Fill in:
   - **App name**: e.g., `Order Cancel Confirmation`
   - **App URL**: Your public HTTPS URL (e.g., `https://cancel.mystore.com`)
   - **Allowed redirection URL(s)**:
     ```
     https://cancel.mystore.com/auth/callback
     https://cancel.mystore.com/auth/shopify/callback
     https://cancel.mystore.com/api/auth/callback
     ```
5. Click **Create app**

### 3. Configure API Scopes

In your app's settings page (Partner Dashboard > Apps > Your App > Configuration):

Under **Access scopes**, request the following:

```
write_orders, read_orders
```

These scopes allow the app to:
- **`read_orders`**: Look up order details (customer email, fulfillment status, financial status)
- **`write_orders`**: Cancel orders, create refunds, add/remove tags

### 4. Get Your API Credentials

After installing the app on your store (Step 8), you can access the API credentials.

1. Go to **your Shopify store admin** > **Settings** > **Apps and sales channels** > **Develop apps** (or find your installed custom app)
2. Under **API credentials**, note the following:
   - **Admin API access token** (`shpat_...`): This is your `SHOPIFY_ADMIN_ACCESS_TOKEN`
   - **API key**: This is your `SHOPIFY_API_KEY`
   - **API secret key**: This is used for `SHOPIFY_WEBHOOK_SECRET`

Alternatively, if you are using the Partner Dashboard approach:
1. Go to **Apps** > **Your App** > **Client credentials**
2. Copy the **Client secret** — this will serve as your `SHOPIFY_APP_PROXY_SHARED_SECRET`
3. The webhook signing secret is separate — see Step 6

### 5. Configure the App Proxy

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
- Requests are also validated against a 5-minute timestamp window to prevent replay attacks

### 6. Register Webhooks

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

**HMAC verification:** Every incoming webhook is verified with HMAC-SHA256 using your `SHOPIFY_WEBHOOK_SECRET`. The raw request body is hashed and compared (timing-safe) against the `X-Shopify-Hmac-Sha256` header. Invalid signatures are rejected with `401 Unauthorized`.

**Deduplication:** Shopify may deliver the same webhook multiple times. The app tracks each `X-Shopify-Webhook-Id` in the database. Duplicate deliveries are silently ignored via `INSERT ... ON CONFLICT DO NOTHING`. Old webhook events (>30 days) are automatically cleaned up by a background worker.

### 7. Configure Admin Link Extension

Optionally, you can add a link in the Shopify admin order detail page that links to your app's admin dashboard.

1. In the Partner Dashboard, go to **Apps** > **Your App** > **Extensions**
2. Create an **Admin link** extension pointing to your admin dashboard URL

### 8. Install the App on Your Store

1. In the Partner Dashboard, go to **Apps** > **Your App**
2. Click **Select store** or use the distribution link
3. Choose your development or production store
4. Review the permissions (read/write orders) and click **Install app**
5. After installation, the Admin API access token becomes available

### 9. Link the Form in Your Storefront

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

## Environment Variables

All configuration is done via environment variables, loaded from a `.env` file. Copy `.env.example` to `.env` as a starting point:

```bash
cp .env.example .env
```

### Required Variables

| Variable | Description | Example |
|---|---|---|
| `APP_BASE_URL` | The public HTTPS URL where your app is hosted. Used for generating confirmation email links. Must include the protocol (`https://`). | `https://cancel.mystore.com` |
| `SHOPIFY_STORE_DOMAIN` | Your store's `.myshopify.com` domain. Used to construct Shopify Admin API URLs. Do not include `https://`. | `my-store.myshopify.com` |
| `SHOPIFY_ADMIN_ACCESS_TOKEN` | Admin API access token from your installed Shopify app. Starts with `shpat_`. Used for all Shopify GraphQL API calls (order lookups, cancellations, refunds, tagging). | `shpat_xxxxxxxxxxxxxxxxxxxx` |
| `SHOPIFY_APP_PROXY_SHARED_SECRET` | The shared secret from your App Proxy configuration in the Partner Dashboard. Used to verify that incoming requests to `/proxy/*` genuinely come from Shopify. | (from Shopify Partners) |
| `SHOPIFY_WEBHOOK_SECRET` | The webhook signing secret from your app's webhook configuration. Used to verify HMAC-SHA256 signatures on all incoming webhook payloads. | (from Shopify Partners) |
| `SMTP_HOST` | Hostname of your SMTP server. | `smtp.resend.com` |
| `SMTP_PORT` | Port number for the SMTP server. Common values: `465` (SSL/TLS), `587` (STARTTLS), `25` (unencrypted). | `465` |
| `SMTP_USER` | Username for SMTP authentication. | `resend` |
| `SMTP_PASS` | Password or API key for SMTP authentication. | `re_xxxxxxxxxxxx` |
| `EMAIL_FROM` | The "From" address for cancellation confirmation emails. Can include a display name. Must be a verified sender with your SMTP provider. | `My Store <no-reply@mystore.com>` |
| `ADMIN_API_TOKEN` | Secret token for accessing the admin dashboard. Used for both browser login and Bearer token API authentication. Generate with `openssl rand -hex 32`. Must be at least 16 characters. This token is hashed at startup — even a memory dump will not expose the raw value. | (use `openssl rand -hex 32`) |

> **Note on `ADMIN_API_TOKEN`:** This is the token you use to log in to the admin dashboard at `/admin`. It is NOT the same as `SHOPIFY_ADMIN_ACCESS_TOKEN`. The Shopify token talks to the Shopify API; the admin token protects your app's own dashboard.

### Optional Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Port the HTTP server listens on. Must be 1-65535. |
| `SHOPIFY_ADMIN_API_VERSION` | `2026-01` | Shopify Admin API version string. Only change this if you need a specific API version. |
| `SHOPIFY_API_KEY` | (none) | Your app's API key from the Partner Dashboard. Currently used only for identification purposes. |
| `SMTP_SECURE` | `true` | Whether to use TLS for the SMTP connection. Set to `false` for STARTTLS on port 587 or unencrypted on port 25. |
| `CANCEL_TOKEN_TTL_MINUTES` | `30` | How long (in minutes) the confirmation link in the email remains valid. After this time, the customer must submit a new request. |
| `CANCEL_NOTIFY_CUSTOMER` | `true` | Whether Shopify sends its own cancellation notification email to the customer (in addition to your app's email). Set to `false` to suppress Shopify's email. |
| `CANCEL_RESTOCK` | `true` | Whether to automatically restock inventory when an order is cancelled. |
| `CANCEL_REFUND` | `false` | Initial auto-refund setting. When `true`, cancellations automatically include a full refund. When `false`, orders are cancelled without refund and tagged `refund-pending` for admin review. This can be toggled at any time from the admin dashboard. |
| `ORDER_LOOKBACK_DAYS` | `90` | Only allow cancellation for orders placed within this many days. Orders older than this are rejected. |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Time window (in milliseconds) for the cancellation request rate limiter. |
| `RATE_LIMIT_MAX_REQUESTS` | `5` | Maximum number of cancellation requests allowed per IP address within the rate limit window. |
| `LOG_LEVEL` | `info` | Log verbosity. Options: `debug`, `info`, `warn`, `error`. The `audit` level is always logged regardless of this setting. |
| `DATA_DIR` | `./data` | Directory where the SQLite database file (`cancel-requests.db`) is stored. Must be writable by the app process. In Docker, this defaults to `/app/data`. |
| `TRUST_PROXY` | `0` (disabled) | Set to `1` when running behind exactly one reverse proxy (Nginx, Caddy, Cloudflare). This tells Express to trust the `X-Forwarded-For` header for client IP detection, which is critical for rate limiting. Without this, all requests appear to come from the proxy's IP. **Do not enable if the app is directly exposed to the internet.** |
| `SENTRY_DSN` | (none) | Optional Sentry DSN for error monitoring. Requires installing `@sentry/node`. |
| `SENTRY_TRACES_SAMPLE_RATE` | `0.1` | Sentry performance monitoring sample rate (0.0 to 1.0). |
| `BACKUP_DIR` | `${DATA_DIR}/backups` | Directory for database backup files (used by `scripts/backup-db.sh`). |
| `BACKUP_RETENTION_DAYS` | `30` | Number of days to retain database backups before auto-cleanup. |

---

## Installation and Running

### With Docker (Recommended)

Docker is the recommended way to run this application. The Docker image includes everything needed to operate the app: Node.js runtime, SQLite CLI (`sqlite3`) for database inspection and backups, `curl` for health checks, and the backup script.

#### 1. Clone the Repository

```bash
git clone https://github.com/pbm-spain/shopify-order-cancel-app.git
cd shopify-order-cancel-app
```

#### 2. Configure Environment Variables

```bash
# Copy the example file
cp .env.example .env

# Generate a secure admin token
openssl rand -hex 32
```

Open `.env` in your editor and fill in all required values (see [Environment Variables](#environment-variables)). At a minimum, you need:

1. Your Shopify API credentials (`SHOPIFY_ADMIN_ACCESS_TOKEN`, `SHOPIFY_STORE_DOMAIN`)
2. Your app's public URL (`APP_BASE_URL`)
3. Shopify security secrets (`SHOPIFY_APP_PROXY_SHARED_SECRET`, `SHOPIFY_WEBHOOK_SECRET`)
4. SMTP email settings (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM`)
5. Admin dashboard token (`ADMIN_API_TOKEN`) — paste the output from `openssl rand -hex 32`

#### 3. Build and Start

```bash
# Build and run in the background
docker compose up -d --build

# Check that the container is running
docker ps

# Verify the app is healthy
docker exec shopify-cancel-app curl -f http://localhost:3000/health
```

The app starts on port 3000 by default. The container is named `shopify-cancel-app` for easy reference in `docker exec` commands.

#### 4. Stop the Application

```bash
# Stop and remove the container (data volume is preserved)
docker compose down

# Stop without removing (can restart with docker compose start)
docker compose stop
```

#### 5. Verify

```bash
curl http://localhost:3000/health
# Expected: {"ok":true,"version":"0.12.0"}
```

#### Volume Mounts

The `docker-compose.yml` creates a Docker named volume `app-data` mounted at `/app/data` inside the container. This volume persists:

- The SQLite database (`cancel-requests.db`)
- WAL files (`cancel-requests.db-wal`, `cancel-requests.db-shm`)
- Database backups (in the `backups/` subdirectory)

The volume survives container rebuilds, restarts, and upgrades. To find its location on the host:

```bash
docker volume inspect shopify-order-cancel-app_app-data
```

#### Environment File

The `.env` file is loaded by docker-compose via the `env_file` directive. You can also override individual variables in the `environment` section of `docker-compose.yml`. Variables set in `environment` take precedence over those in `.env`.

#### Using the Pre-built Image

Instead of building locally, you can use the pre-built image from GitHub Container Registry:

```bash
docker pull ghcr.io/pbm-spain/shopify-order-cancel-app:latest
```

To use it in docker-compose, change the `build: .` line to:

```yaml
services:
  app:
    image: ghcr.io/pbm-spain/shopify-order-cancel-app:latest
    # ... rest of config stays the same
```

Or run directly:

```bash
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

#### Development with Mailpit

For local development, use the `dev` profile to start a local SMTP server (Mailpit) that catches all outgoing emails:

```bash
docker compose --profile dev up -d
```

- **Mailpit Web UI** (view caught emails): http://localhost:8025
- **Mailpit SMTP**: localhost:1025

Set these in your `.env` for local development:

```
SMTP_HOST=mailpit
SMTP_PORT=1025
SMTP_SECURE=false
SMTP_USER=test
SMTP_PASS=test
```

### Without Docker (Development)

#### 1. Clone and Install

```bash
git clone https://github.com/pbm-spain/shopify-order-cancel-app.git
cd shopify-order-cancel-app
npm ci
```

> **Note:** `better-sqlite3` is a native C++ addon. On Linux, you may need `python3`, `make`, and `g++` installed. On macOS, Xcode Command Line Tools are required (`xcode-select --install`).

#### 2. Configure Environment

```bash
cp .env.example .env
# Edit .env with your values (see Environment Variables section)
```

#### 3. Run

```bash
# Development mode (auto-restarts on file changes)
npm run dev

# Production mode
npm start
```

The server starts on `http://localhost:3000` by default:

```bash
curl http://localhost:3000/health
# Expected: {"ok":true,"version":"0.12.0"}
```

---

## API Endpoints Reference

### Health Check

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/health` | None | Returns `{"ok":true,"version":"0.12.0"}` when healthy, `503` with `{"ok":false,"error":"Database unavailable"}` if the database is unreachable. Used by Docker health checks, load balancers, and monitoring services. |

### Customer-Facing Endpoints

| Method | Path | Auth | Rate Limit | Description |
|---|---|---|---|---|
| `GET` | `/cancel-order` | None | None | Serves the standalone cancellation request form (HTML). Includes a CSRF token. |
| `GET` | `/proxy` | App Proxy HMAC | None | Serves the cancellation form through Shopify's App Proxy. Returns `application/liquid` so Shopify wraps it in the store theme. Verifies HMAC signature and 5-minute timestamp window. |
| `POST` | `/proxy/request` | App Proxy HMAC + CSRF | 5/min per IP, 3/hr per email | Submits a cancellation request. Validates the order via Shopify GraphQL API, checks eligibility (fulfillment status, financial status, age), generates a SHA-256 hashed token, and sends a confirmation email. Works for both App Proxy and standalone flows. |
| `GET` | `/confirm?token=<token>` | Token in URL | 30/hr per IP | Confirms a cancellation from the email link. Validates the token (single-use, time-limited), re-verifies the order with Shopify, and sends the `orderCancel` GraphQL mutation. |

### Webhook Endpoints

All webhook endpoints verify HMAC-SHA256 signatures using the raw request body and `SHOPIFY_WEBHOOK_SECRET`. They always return `200 OK` to prevent Shopify from retrying indefinitely.

| Method | Path | Shopify Topic | Description |
|---|---|---|---|
| `POST` | `/webhooks/orders/updated` | `orders/updated` | Auto-denies pending cancellation requests if the order moves to a non-allowed fulfillment status (e.g., it ships). |
| `POST` | `/webhooks/orders/cancelled` | `orders/cancelled` | Marks pending requests as `cancelled_externally` when an order is cancelled outside the app. |
| `POST` | `/webhooks/refunds/create` | `refunds/create` | Marks pending refunds as approved when a refund is created outside the app. |

### Admin Endpoints

All admin endpoints require authentication: either a server-side session cookie (from browser login) or an `Authorization: Bearer <ADMIN_API_TOKEN>` header.

| Method | Path | CSRF | Rate Limit | Description |
|---|---|---|---|---|
| `POST` | `/admin/login` | No | 5 attempts/15 min per IP | Authenticates with the admin token. Sets a session cookie with IP binding (8-hour TTL). |
| `GET` | `/admin/logout` | No | None | Clears the session and redirects to login. |
| `GET` | `/admin` | No | None | Renders the admin dashboard HTML (settings panel, pending refunds table, cancellation history table with pagination). |
| `POST` | `/admin/api/settings` | Yes | 20/min per IP | Updates a setting. JSON body: `{"key": "auto_refund", "value": "true"}`. Valid keys: `auto_refund`, `allowed_fulfillment_statuses`, `allowed_financial_statuses`. |
| `POST` | `/admin/refund/approve` | Yes | None | Approves a pending refund. Creates the refund in Shopify via `refundCreate` GraphQL mutation with an idempotency key and removes the `refund-pending` tag. Atomic state transition prevents double-approval. |
| `POST` | `/admin/refund/deny` | Yes | None | Denies a pending refund. Updates the status in the database without creating a Shopify refund. |

---

## Admin Dashboard

Access the dashboard at `https://your-app.example.com/admin`. Log in with the value you set for `ADMIN_API_TOKEN`.

### Settings Panel

- **Auto-refund toggle:** When ON, cancellations automatically include a full refund. When OFF, orders are cancelled without refund and tagged `refund-pending` for manual review.
- **Allowed fulfillment statuses:** Select which Shopify fulfillment statuses allow cancellation. Options: Unfulfilled, Partially Fulfilled, Scheduled, On Hold. Default: `UNFULFILLED` only.
- **Allowed financial statuses:** Select which Shopify financial statuses allow cancellation. Options: Pending, Authorized, Paid, Partially Paid, Partially Refunded. Default: `PENDING`, `AUTHORIZED`, `PAID`.

Settings are persisted in the SQLite database and take effect immediately.

### Pending Refunds Table

When auto-refund is OFF, pending refunds appear in a paginated table (25 per page). Each row shows the order number (linked to Shopify admin), customer email, cancellation date, and **Approve** / **Deny** buttons.

Approving a refund:
1. Verifies the order is still cancelled in Shopify
2. Atomically transitions the refund status from `pending` to `approved` (prevents double-approval)
3. Creates the refund via the Shopify GraphQL `refundCreate` mutation with an idempotency key
4. Removes the `refund-pending` tag from the order in Shopify

### Recent Cancellations Table

A paginated table of all processed cancellations with their refund status badge: **Automatic**, **Approved**, **Denied**, **Pending**, **Error**.

### API Access

You can also interact with the admin programmatically using Bearer token authentication:

```bash
# Toggle auto-refund
curl -X POST https://your-app.example.com/admin/api/settings \
  -H "Authorization: Bearer <your-admin-token>" \
  -H "Content-Type: application/json" \
  -d '{"key": "auto_refund", "value": "true"}'

# Update allowed fulfillment statuses
curl -X POST https://your-app.example.com/admin/api/settings \
  -H "Authorization: Bearer <your-admin-token>" \
  -H "Content-Type: application/json" \
  -d '{"key": "allowed_fulfillment_statuses", "value": ["UNFULFILLED", "PARTIALLY_FULFILLED"]}'
```

---

## Database

### Tables

The app uses a single SQLite database running in WAL (Write-Ahead Logging) mode for concurrent read/write access, with a 5-second busy timeout.

#### `cancel_requests`

Stores every cancellation request.

| Column | Type | Description |
|---|---|---|
| `id` | TEXT (UUID) | Primary key |
| `token_hash` | TEXT | SHA-256 hash of the confirmation token (UNIQUE) |
| `shop_domain` | TEXT | Shopify store domain |
| `order_id` | TEXT | Shopify GraphQL GID (e.g., `gid://shopify/Order/123`) |
| `order_number` | TEXT | Human-readable order number (e.g., `#1001`) |
| `email` | TEXT | Customer email (normalized to lowercase) |
| `status` | TEXT | Request status: `pending_confirmation`, `cancelled`, `denied`, `error`, `cancelled_externally` |
| `refund_status` | TEXT | Refund status: `none`, `pending_approval`, `approved`, `denied`, `auto_refunded`, `error` |
| `expires_at` | TEXT | Token expiration timestamp |
| `created_at` | TEXT | Request creation timestamp |
| `updated_at` | TEXT | Last update timestamp |
| `used_at` | TEXT | When the token was used (NULL if unused) |
| `cancelled_at` | TEXT | When the order was cancelled |
| `cancel_job_id` | TEXT | Shopify async Job ID from `orderCancel` mutation |
| `refunded_at` | TEXT | When the refund was processed |
| `ip_address` | TEXT | Client IP address |
| `email_sent` | INTEGER | Whether the confirmation email was sent (0/1) |
| `email_attempts` | INTEGER | Number of email send attempts |
| `last_email_attempt_at` | TEXT | Timestamp of last email attempt |

#### `admin_settings`

Key-value store for admin-configurable settings.

| Column | Type | Description |
|---|---|---|
| `key` | TEXT | Setting name (PRIMARY KEY) |
| `value` | TEXT | Setting value (JSON for arrays) |
| `updated_at` | TEXT | Last update timestamp |

Default settings:
- `auto_refund`: `true`
- `allowed_fulfillment_statuses`: `["UNFULFILLED"]`
- `allowed_financial_statuses`: `["PENDING", "AUTHORIZED", "PAID"]`

#### `webhook_events`

Webhook deduplication log.

| Column | Type | Description |
|---|---|---|
| `webhook_id` | TEXT | Shopify webhook ID (PRIMARY KEY) |
| `received_at` | TEXT | When the webhook was received |

### Storage Location

- **Docker**: `/app/data/cancel-requests.db` (inside the container), persisted via the `app-data` named volume
- **Without Docker**: `./data/cancel-requests.db` by default, configurable via `DATA_DIR`

The database is created automatically on first startup. All tables and indexes are created via `CREATE TABLE IF NOT EXISTS` statements.

### Backup Strategy

The included backup script (`scripts/backup-db.sh`) creates consistent, hot backups without stopping the app:

1. Uses SQLite's `VACUUM INTO` for a consistent point-in-time snapshot (safe with WAL mode)
2. Compresses the backup with gzip
3. Verifies backup integrity with `PRAGMA integrity_check`
4. Auto-deletes backups older than `BACKUP_RETENTION_DAYS` (default: 30)

See [Docker Operations > Using the Backup Script](#using-the-backup-script) for how to run backups in Docker.

---

## Docker Operations

The Docker image includes `sqlite3`, `curl`, and the backup script, so you can perform all operational tasks directly inside the container. The container is named `shopify-cancel-app` (set in `docker-compose.yml`).

### Running Backups

Create a one-off backup of the database:

```bash
docker exec shopify-cancel-app sqlite3 /app/data/cancel-requests.db ".backup /app/data/backup.db"
```

This creates a raw SQLite backup at `/app/data/backup.db` inside the container (persisted in the volume).

### Inspecting the Database

Open an interactive SQLite session:

```bash
docker exec -it shopify-cancel-app sqlite3 /app/data/cancel-requests.db
```

Useful queries inside the SQLite shell:

```sql
-- List all tables
.tables

-- View schema
.schema cancel_requests

-- Recent cancellation requests
SELECT id, order_number, email, status, refund_status, created_at
FROM cancel_requests ORDER BY created_at DESC LIMIT 20;

-- Pending refunds
SELECT order_number, email, created_at
FROM cancel_requests WHERE refund_status = 'pending_approval';

-- Count requests by status
SELECT status, COUNT(*) FROM cancel_requests GROUP BY status;

-- Count requests by refund status
SELECT refund_status, COUNT(*) FROM cancel_requests GROUP BY refund_status;

-- Check admin settings
SELECT * FROM admin_settings;

-- Recent webhook events
SELECT * FROM webhook_events ORDER BY received_at DESC LIMIT 10;

-- Exit
.quit
```

One-liner queries (non-interactive):

```bash
# Count total requests
docker exec shopify-cancel-app sqlite3 /app/data/cancel-requests.db "SELECT COUNT(*) FROM cancel_requests;"

# List pending refunds
docker exec shopify-cancel-app sqlite3 /app/data/cancel-requests.db \
  "SELECT order_number, email, created_at FROM cancel_requests WHERE refund_status = 'pending_approval';"

# Check current settings
docker exec shopify-cancel-app sqlite3 /app/data/cancel-requests.db "SELECT * FROM admin_settings;"
```

### Viewing Logs

```bash
# Follow logs in real-time (docker compose)
docker compose logs -f

# Follow logs for the app container only
docker logs -f shopify-cancel-app

# Last 100 lines
docker logs --tail 100 shopify-cancel-app

# Logs since a specific time
docker logs --since 2h shopify-cancel-app

# Logs with timestamps
docker logs -t shopify-cancel-app
```

All logs are JSON-formatted to stdout/stderr, compatible with any log aggregation service (Datadog, CloudWatch, ELK, Loki, Grafana, etc.).

### Health Check

```bash
# Check health from inside the container
docker exec shopify-cancel-app curl -f http://localhost:3000/health

# Check health from the host
curl http://localhost:3000/health

# Check Docker's built-in health status
docker inspect --format='{{.State.Health.Status}}' shopify-cancel-app
```

The Docker image includes an automatic health check (every 30 seconds, 5-second timeout, 3 retries). Docker will mark the container as `unhealthy` if the health check fails.

### Using the Backup Script

The backup script creates compressed, integrity-verified backups with automatic retention:

```bash
# Run the backup script (uses defaults: /app/data/backups, 30-day retention)
docker exec shopify-cancel-app /app/scripts/backup-db.sh

# Custom backup directory and retention
docker exec -e BACKUP_DIR=/app/data/backups -e BACKUP_RETENTION_DAYS=14 \
  shopify-cancel-app /app/scripts/backup-db.sh

# List existing backups
docker exec shopify-cancel-app ls -la /app/data/backups/
```

**Automated daily backups via cron** (run on the host):

```bash
# Edit the host's crontab
crontab -e

# Add this line for daily backups at 03:00
0 3 * * * docker exec shopify-cancel-app /app/scripts/backup-db.sh >> /var/log/cancel-app-backup.log 2>&1
```

**Copy a backup to the host:**

```bash
docker cp shopify-cancel-app:/app/data/backups/ ./local-backups/
```

### Accessing a Shell Inside the Container

```bash
docker exec -it shopify-cancel-app sh
```

From inside the container, you can run any commands: `sqlite3`, `curl`, `node`, etc.

### Updating the Application

```bash
# Pull latest code
git pull origin main

# Rebuild and restart
docker compose up -d --build

# Or if using the pre-built image
docker compose pull
docker compose up -d
```

The database volume persists across rebuilds — your data is safe.

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
| Error Handler | `error-handler.test.js` | P2 | Error capture, Express error middleware |
| Edge Cases | `edge-cases.test.js` | P2 | Token expiry/reuse, admin pagination, settings validation, storage atomicity |

---

## CI/CD

### CI Pipeline

The GitHub Actions CI runs on every push and pull request to `main` (`.github/workflows/ci.yml`):

1. **Matrix test** — Runs on Node.js 20 and 22
2. **Security audit** — `npm audit --audit-level=high` (fails on high/critical vulnerabilities)
3. **Linting** — ESLint with ES2022 rules
4. **Tests** — Full Vitest suite

### Docker Publish Pipeline

On every push to `main`, the Docker Publish workflow (`.github/workflows/docker-publish.yml`):

1. Builds a multi-platform image (`linux/amd64` + `linux/arm64`)
2. Runs a Trivy vulnerability scan (severity: CRITICAL, HIGH)
3. Pushes to `ghcr.io/pbm-spain/shopify-order-cancel-app` with tags: `latest` and `sha-<commit>`
4. Uses GitHub Actions layer caching for faster builds

---

## Security

### Authentication and Authorization

| Layer | Mechanism |
|---|---|
| App Proxy (customer requests) | HMAC-SHA256 signature verification using Shopify's shared secret + 5-minute timestamp window |
| Webhooks | HMAC-SHA256 signature verification using the webhook signing secret |
| Admin dashboard (browser) | Opaque server-side session tokens with IP binding (8-hour TTL) |
| Admin API (programmatic) | Bearer token authentication (`Authorization: Bearer <token>`) |

### CSRF Protection

- **Customer forms:** Double-submit cookie pattern. A random token is set in a cookie and included as a hidden form field. Both must match on submission (timing-safe comparison).
- **Admin panel:** Session-based CSRF tokens. One token per session, verified with `crypto.timingSafeEqual`.

### Rate Limiting

| Endpoint | Limit | Window | Key |
|---|---|---|---|
| `POST /proxy/request` | 5 requests | 1 minute | Per IP address |
| `POST /proxy/request` | 3 requests | 1 hour | Per email address |
| `GET /confirm` | 30 requests | 1 hour | Per IP address |
| `POST /admin/login` | 5 attempts | 15 minutes | Per IP address |
| `POST /admin/api/settings` | 20 requests | 1 minute | Per IP address |

Rate limiting uses an in-memory sliding window implementation. Counters reset on app restart.

### Token Security

- Confirmation tokens are 64-character hex strings (256-bit entropy, generated with `crypto.randomBytes`)
- Tokens are hashed with SHA-256 before database storage — raw tokens never touch the database
- Tokens are single-use: atomic `WHERE used_at IS NULL` check prevents reuse
- Tokens expire after `CANCEL_TOKEN_TTL_MINUTES` (default: 30 minutes)

### HTTP Security Headers

Every response includes:

```
Content-Security-Policy: default-src 'self'; script-src 'self' 'nonce-<random>'; style-src 'self' 'nonce-<random>' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Referrer-Policy: strict-origin-when-cross-origin
Strict-Transport-Security: max-age=31536000; includeSubDomains  (HTTPS only)
```

CSP nonces are randomly generated per request and injected into all `<style>` and `<script>` tags.

### Additional Protections

- All sensitive comparisons (HMAC, tokens) use `crypto.timingSafeEqual` to prevent timing attacks
- SQL injection prevention via prepared statements (better-sqlite3 parameterized queries)
- Input validation on all user inputs: email format regex, order number regex (`#` + digits), UUID format validation
- Open redirect protection on admin login (redirect URLs are validated to `/admin` paths only)
- Content-Type validation: returns `415 Unsupported Media Type` for unexpected content types
- Request body size limit: 10KB maximum
- Admin session IP binding: sessions are invalidated if the client IP changes
- `TRUST_PROXY` must be explicitly enabled — prevents `X-Forwarded-For` header spoofing
- Sensitive query parameters (`token`, `signature`, `hmac`) are redacted in HTTP access logs
- Admin token is hashed at startup — not stored in plaintext in memory

---

## Troubleshooting

### "Invalid App Proxy signature"

- Verify `SHOPIFY_APP_PROXY_SHARED_SECRET` matches the secret in your Shopify app's App Proxy settings
- Ensure you are accessing the form through the Shopify storefront URL (`https://your-store.myshopify.com/apps/order-cancel/...`), not directly hitting your server
- The signature is only valid for requests proxied through Shopify

### "Invalid webhook signature"

- Verify `SHOPIFY_WEBHOOK_SECRET` matches the signing secret in your app's webhook settings
- Ensure the webhook endpoint URL matches your `APP_BASE_URL` exactly (including protocol and path)
- Check that no middleware is modifying the raw request body before signature verification

### Emails not sending

- Check SMTP credentials in `.env` (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`)
- Verify your SMTP provider allows sending from the `EMAIL_FROM` address (sender verification/domain authentication may be required)
- Check logs for email errors: set `LOG_LEVEL=debug` and restart
- Failed emails are retried up to 5 times by the background queue
- For local testing, use Mailpit: `docker compose --profile dev up -d` and check `http://localhost:8025`

### Rate limit issues

- If behind a proxy, set `TRUST_PROXY=1` so Express reads the real client IP from `X-Forwarded-For`
- Without `TRUST_PROXY`, all requests appear from the proxy's IP, triggering rate limits immediately
- Rate limit counters reset on app restart (in-memory only)

### Admin dashboard won't load

- Ensure `ADMIN_API_TOKEN` is set in `.env` and is at least 16 characters
- If you get "Session IP mismatch", your IP may have changed — log in again
- Clear browser cookies if sessions are stale
- Check that you are using the correct token value (no extra whitespace)

### Database errors

- Ensure `DATA_DIR` exists and is writable by the app process
- In Docker, check the volume is mounted correctly: `docker inspect shopify-cancel-app`
- Check available disk space: `df -h`
- The database uses WAL mode with a 5-second busy timeout — concurrency is generally not an issue
- If the database is corrupted, restore from a backup and check disk health

### Order not found / not cancelable

- Order must be within `ORDER_LOOKBACK_DAYS` (default: 90 days)
- Order's fulfillment status must be in the allowed list (default: `UNFULFILLED`)
- Order's financial status must be in the allowed list (default: `PENDING`, `AUTHORIZED`, `PAID`)
- Order must not have fulfillment orders with status `IN_PROGRESS`, `ON_HOLD`, or `INCOMPLETE`
- Check the admin dashboard settings to see current allowed statuses

### Connection issues

- Verify your `APP_BASE_URL` is reachable from the internet (Shopify needs to reach it for App Proxy and webhooks)
- Check firewall rules allow inbound traffic on your configured port
- For HTTPS, verify your SSL certificate is valid and not expired
- Check DNS resolution for your domain

### Docker-specific issues

- **Container keeps restarting:** Check logs with `docker logs shopify-cancel-app` — likely a missing or invalid environment variable
- **Health check failing:** Run `docker exec shopify-cancel-app curl -f http://localhost:3000/health` to see the response
- **Database permissions:** The container runs as non-root user `appuser` (UID 1001). Ensure the data volume is writable
- **Cannot exec into container:** Use `docker exec -it shopify-cancel-app sh` (not bash — Alpine uses sh)

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

> **Important:** When behind a reverse proxy, set `TRUST_PROXY=1` in your `.env`.

---

## License

Private — All rights reserved.
