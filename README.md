# Shopify Order Cancel Confirmation App (v0.8.4)

Node.js application that allows customers of a Shopify store to request order cancellations through a form integrated as an App Proxy. The flow includes email confirmation and an admin panel for managing refunds.

## v0.8.4 Changes

**Critical Fixes:**
- Fixed raw body capture: replaced stream-based listener (which consumed the stream before Express body parsers) with the `verify` callback pattern on `express.json()` and `express.urlencoded()`. Without this fix, `req.body` was empty on all POST routes.
- Fixed CSP nonce injection: all HTML templates (`form.html`, `admin.html`, `success.html`, `request-sent.html`, admin login page) now include `nonce="{{NONCE}}"` on `<style>` and `<script>` tags. Without this, CSP blocked all inline scripts and styles.
- Fixed webhook order ID format mismatch: webhooks deliver REST numeric IDs (e.g. `12345`) but the database stores GraphQL GIDs (e.g. `gid://shopify/Order/12345`). Added `toOrderGid()` conversion. Without this, no webhook handler could ever match a pending request.
- Fixed webhook REST field names: `handleOrderUpdated` now reads `fulfillment_status` and `cancelled_at` (REST snake_case) instead of `displayFulfillmentStatus` and `cancelledAt` (GraphQL camelCase). Added REST-to-GraphQL fulfillment status mapping.

**Minor Fixes:**
- Fixed email queue backoff: backoff delay now calculates from `last_email_attempt_at` instead of `createdAt`, preventing immediate retries after the initial delay window passes. Added `last_email_attempt_at` column to database.
- Removed fragile `global.setInterval` override that monkey-patched the global function to track intervals. Background workers now manage their own cleanup via explicit start/stop functions.

## v0.8.3 Changes

**Improvements:**
- Added `error` case to `refundBadge` function with proper escapeHtml fallback for unknown statuses
- Refactored admin session cleanup as exportable `startSessionCleanup()`/`stopSessionCleanup()` functions for proper lifecycle management
- Server startup and shutdown now properly manage session cleanup interval

## v0.8.2 Changes

**Documentation:**
- Fixed database filename references: updated all occurrences from `requests.db` to `cancel-requests.db` (the actual database file used by the app)
- Added explanation of Shopify App Proxy routing behavior to clarify how customer-facing URLs and server-side endpoints work

## v0.8.1 Changes

**Critical Fixes:**
- Fixed OrderCancelReason enum documentation: changed from PAYMENT and STAFF_ERROR to verified Shopify API values (CUSTOMER, DECLINED, FRAUD, INVENTORY, OTHER, STAFF)

**High Priority Fixes:**
- Email queue race condition fixed: send email FIRST, then update token hash ONLY after successful send (prevents broken links if email fails)
- Admin CSRF token now regenerates on EVERY page load (prevents stale token issues if page stays open for hours)
- Rate limit on /confirm endpoint now uses IP as primary key (30 attempts/hour per IP) to prevent per-token brute-force bypass

**Medium Priority Fixes:**
- Added UUID format validation on admin refund endpoints (/admin/refund/approve and /admin/refund/deny)
- Added webhook event cleanup: removes events older than 30 days, runs on startup and every 24 hours
- Documented that orderCancel() returns a Job (async); order may not be immediately cancelled (relies on webhooks for notification)
- Added atomic transaction for admin settings updates (setSettingAtomic)
- Added database index on created_at column (DESC) for improved query performance
- Refund approval error handler now sets refund_status to 'error' (prevents stuck pending_approval state)
- Removed unused variable from webhook handlers

## v0.8.0 Changes

**Critical Fixes:**
- Fixed OrderCancelReason enum documentation: changed from PAYMENT and STAFF_ERROR to verified Shopify API values (CUSTOMER, DECLINED, FRAUD, INVENTORY, OTHER, STAFF)

**High Priority Fixes:**
- Email queue race condition fixed: send email FIRST, then update token hash ONLY after successful send (prevents broken links if email fails)
- Admin CSRF token now regenerates on EVERY page load (prevents stale token issues if page stays open for hours)
- Rate limit on /confirm endpoint now uses IP as primary key (30 attempts/hour per IP) to prevent per-token brute-force bypass

**Medium Priority Fixes:**
- Added UUID format validation on admin refund endpoints (/admin/refund/approve and /admin/refund/deny)
- Added webhook event cleanup: removes events older than 30 days, runs on startup and every 24 hours
- Documented that orderCancel() returns a Job (async); order may not be immediately cancelled (relies on webhooks for notification)
- Added atomic transaction for admin settings updates (setSettingAtomic)
- Added database index on created_at column (DESC) for improved query performance
- Refund approval error handler now sets refund_status to 'error' (prevents stuck pending_approval state)
- Removed unused variable from webhook handlers

## v0.7.0 Changes

**Critical Fixes:**
- Fixed idempotency implementation to use GraphQL `@idempotent` directive instead of HTTP headers (Shopify GraphQL requirement)
- Simplified admin CSRF protection with session-based tokens (removed single-use nonce complexity)

**High Priority Fixes:**
- Email retry queue now generates new tokens on retry for fresh confirmation links
- HTML pattern validation for order numbers now matches server-side regex (#[1-9]\\d{0,18})
- Health check endpoint now tests database connectivity
- Database INSERT statement includes email_sent and email_attempts columns

**Medium Priority Fixes:**
- CSRF cookie TTL extended to 24 hours for better UX
- Webhook deduplication prevents processing duplicate Shopify webhooks
- Rate limiting on /confirm now uses token hash instead of just IP
- Refund approval errors now set DB status to 'error'
- Admin refund actions now logged with admin IP for audit trail
- HTML content rendering uses escapeHtml instead of escapeAttr
- SQLite database optimized on shutdown with PRAGMA optimize

## Cancellation Flow

1. The customer accesses the form (`/cancel-order`) from the storefront.
2. They enter their email and order number.
3. The app verifies the App Proxy HMAC signature, validates the order, and sends a confirmation email with a temporary link.
4. The customer clicks the link to confirm the cancellation.
5. Depending on the admin settings:
   - **Automatic refund**: the order is cancelled and the refund is issued immediately.
   - **Manual approval**: the order is cancelled without a refund, tagged with `refund-pending` in Shopify along with an internal note, and remains pending approval in the admin panel.

## Requirements

- Node.js 18+
- Shopify account with App Proxy configured
- SMTP server for sending emails
- Access to the Admin GraphQL API (API version `2026-01`)

## Installation

```bash
git clone <repo-url>
cd shopify-order-cancel-app
cp .env.example .env
# Edit .env with your credentials
npm install
npm start
```

For development with auto-reload:

```bash
npm run dev
```

## Deployment Guide

This guide covers the complete setup and deployment process for the Shopify Order Cancel Confirmation App.

### Prerequisites

Before starting, ensure you have:

- **Node.js 18+** — Check with `node --version`
- **A Shopify store** — Basic plan or higher
- **A Shopify Partners account** — Free account at [partners.shopify.com](https://partners.shopify.com)
- **SMTP credentials** — From Gmail, SendGrid, Mailgun, AWS SES, or similar
- **A hosting platform** — Railway (recommended), Render, Fly.io, or any VPS with Node.js support
- **Git** — To clone the repository (optional if downloading as ZIP)

### Step 1: Create the App in Shopify Partners

1. Go to [partners.shopify.com](https://partners.shopify.com)
2. Sign in or create a free account
3. Click **Apps and channels** → **Apps** (left sidebar)
4. Click **Create app** → Select **Create app manually**
5. Enter an app name (e.g., "Order Cancel Confirmation")
6. Select **Admin API** and review the permissions
7. Click **Create app**

#### Record Your Credentials

In the **Configuration** tab, you'll see:
- **Client ID** — This is your `SHOPIFY_CLIENT_ID`
- **Client secret** — Copy and save this securely (shown only once)

#### Add API Scopes

1. Go to **Configuration** → **Admin API access scopes**
2. Check these scopes:
   - `read_orders` — Read order data
   - `write_orders` — Cancel orders and create refunds
3. Click **Save**

#### Install on Your Store and Get Access Token

1. Go to **Configuration** → **Install app** (near the top)
2. Select your store and click **Install**
3. You'll be redirected to grant permissions — click **Install app**
4. After installation, go back to **Configuration**
5. Under **Admin API access tokens**, you'll see a token starting with `shpat_`
6. **Copy this token and save it** — It will not be shown again
7. This token is your `SHOPIFY_ADMIN_ACCESS_TOKEN`

### Step 2: Configure App Proxy

App Proxy allows customers to access the cancellation form directly from your Shopify store.

1. In Shopify Partners, go to **Configuration** → **App setup** (scroll down)
2. Find the **App proxy** section and click **Set up**
3. Configure:
   - **Sub path prefix**: `apps`
   - **Sub path**: `order-cancel`
   - **Proxy URL**: `https://your-server-url.com/proxy` (replace with your actual server URL)
4. Click **Save**

After deployment, customers will access the form at:
```
https://your-store.myshopify.com/apps/order-cancel
```

#### How App Proxy Routing Works

When a customer visits `https://your-store.myshopify.com/apps/order-cancel`, Shopify's App Proxy intercepts the request and forwards it to your configured Proxy URL (`https://your-server.com/proxy`).

The form submits to `/apps/order-cancel/request` (the customer-facing path), which Shopify automatically proxies to your server at `/proxy/request`. Your server never needs to handle the `/apps/` path directly — Shopify handles the translation.

This means:
- Customer sees: `https://your-store.myshopify.com/apps/order-cancel`
- Your server receives: `GET /proxy?shop=...&signature=...`
- Form posts to: `/apps/order-cancel/request` (customer browser)
- Your server receives: `POST /proxy/request` (after Shopify proxying)

This is standard Shopify App Proxy behavior, and the HTML form uses relative paths under `/apps/order-cancel/` because that's what the customer's browser sees, while your server always receives requests under the `/proxy/*` path.

### Step 3: Register Webhooks (Optional but Recommended)

Webhooks allow the app to stay in sync with real-time order changes.

1. In Shopify Partners, go to **Configuration** → **Webhooks** (scroll down)
2. Click **Add webhook**
3. Create three webhooks:

| Event | URL |
|---|---|
| `orders/updated` | `https://your-server-url.com/webhooks/orders/updated` |
| `orders/cancelled` | `https://your-server-url.com/webhooks/orders/cancelled` |
| `refunds/create` | `https://your-server-url.com/webhooks/refunds/create` |

4. For each webhook, select the event, enter the URL, and click **Add webhook**
5. After creating all webhooks, find the **Webhook signing secret** at the top of the Webhooks section
6. Copy this secret — it's your `SHOPIFY_WEBHOOK_SECRET`

Webhooks will automatically verify requests using HMAC-SHA256 signatures for security.

### Step 4: Environment Configuration

Copy the `.env.example` file to `.env` and configure each variable:

```bash
cp .env.example .env
```

#### Core Configuration

```env
# Server (required)
PORT=3000
APP_BASE_URL=https://your-app.railway.app
# ^ No trailing slash. This must be a public HTTPS URL

# Shopify (required)
SHOPIFY_STORE_DOMAIN=your-store.myshopify.com
SHOPIFY_ADMIN_API_VERSION=2026-01
SHOPIFY_ADMIN_ACCESS_TOKEN=shpat_xxxxx
# ^ From Step 1, saved when you installed the app

SHOPIFY_APP_PROXY_SHARED_SECRET=xxx
# ^ From Step 2, App proxy settings

SHOPIFY_WEBHOOK_SECRET=xxx
# ^ From Step 3, webhook signing secret (optional if not using webhooks)
```

#### Email Configuration

Choose one of the examples below based on your email provider:

**Gmail:**
```env
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-email@gmail.com
SMTP_PASS=your-app-password
# Generate an app password at myaccount.google.com/apppasswords
EMAIL_FROM=Your Store <noreply@yourdomain.com>
```

**SendGrid:**
```env
SMTP_HOST=smtp.sendgrid.net
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=apikey
SMTP_PASS=SG.xxxxx
EMAIL_FROM=Your Store <noreply@yourdomain.com>
```

**AWS SES:**
```env
SMTP_HOST=email-smtp.us-east-1.amazonaws.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-smtp-username
SMTP_PASS=your-smtp-password
EMAIL_FROM=Your Store <noreply@yourdomain.com>
```

**Mailgun:**
```env
SMTP_HOST=smtp.mailgun.org
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=postmaster@yourdomain.com
SMTP_PASS=your-password
EMAIL_FROM=Your Store <noreply@yourdomain.com>
```

#### Cancellation Behavior

```env
# Token validity in minutes (how long the confirmation link works)
CANCEL_TOKEN_TTL_MINUTES=30

# Notify customer via Shopify when order is cancelled
CANCEL_NOTIFY_CUSTOMER=true

# Restock inventory when order is cancelled
CANCEL_RESTOCK=true

# Automatically create refunds (false = requires manual approval)
CANCEL_REFUND=false

# Days to look back when searching for orders
ORDER_LOOKBACK_DAYS=90
```

#### Admin Panel Access

```env
# Generate a random token: openssl rand -hex 32
ADMIN_API_TOKEN=a-long-random-string-for-admin-panel-access
```

#### Rate Limiting

```env
# Rate limiting window in milliseconds (1 minute = 60000)
RATE_LIMIT_WINDOW_MS=60000

# Maximum requests allowed per window per IP
RATE_LIMIT_MAX_REQUESTS=5
```

#### Other Settings

```env
# Logging level: debug, info, warn, error
LOG_LEVEL=info

# SQLite database directory (create this directory first)
DATA_DIR=./data
```

### Step 5: Deploy to Railway (Recommended - Easiest)

Railway is the simplest platform for deploying Node.js apps. It has free tier options and automatic SSL.

1. Go to [railway.app](https://railway.app)
2. Sign in with GitHub (or create account)
3. Click **New Project** → **Deploy from GitHub repo**
4. Search for and select your repository (`pbm-spain/shopify-order-cancel-app`)
5. Click **Deploy**

#### Configure Environment Variables

1. After deployment starts, click the **Variables** tab
2. Add all environment variables from your `.env` file:
   - Paste each variable name and value
   - Click **Add Variable** for each one
3. Click **Deploy** to apply changes

#### Get Your Public URL

1. Go to the **Settings** tab
2. Under **Domains**, click **Generate Domain**
3. Copy the generated URL (e.g., `https://shopify-order-cancel-app.railway.app`)
4. Update `APP_BASE_URL` in your environment variables with this URL

#### Update Shopify Configuration

1. Return to Shopify Partners → **Configuration**
2. Update **Application URL** to your Railway URL
3. Update **App proxy** → **Proxy URL** to `https://your-railway-url/proxy`
4. Update **Webhooks** URLs to use your Railway URL
5. Save all changes

### Step 6: Deploy to Render (Alternative)

If you prefer Render over Railway:

1. Go to [render.com](https://render.com)
2. Sign up and connect your GitHub account
3. Click **New** → **Web Service**
4. Select your repository
5. Configure:
   - **Name**: `shopify-order-cancel-app`
   - **Runtime**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
6. Add environment variables in the **Environment** section
7. Click **Create Web Service**
8. Wait for deployment and copy your public URL
9. Update `APP_BASE_URL` and webhook/proxy URLs in Shopify Partners

### Step 7: Deploy to a VPS (Manual, Advanced)

For Ubuntu/Debian servers:

#### Clone and Install

```bash
# Clone the repository
git clone https://github.com/pbm-spain/shopify-order-cancel-app.git
cd shopify-order-cancel-app

# Install dependencies
npm install --production

# Copy and configure environment
cp .env.example .env
# Edit .env with your values
nano .env
```

#### Create Data Directory

```bash
mkdir -p ./data
chmod 755 ./data
```

#### Run with PM2 (Process Manager)

```bash
# Install PM2 globally
npm install -g pm2

# Start the app with PM2
pm2 start src/server.js --name "shopify-cancel-app"

# Save PM2 config so it restarts on server reboot
pm2 startup
pm2 save
```

#### Configure Nginx as Reverse Proxy

```bash
# Create nginx config
sudo nano /etc/nginx/sites-available/shopify-cancel-app
```

Paste this configuration:

```nginx
server {
    listen 80;
    server_name your-domain.com www.your-domain.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Enable the site:

```bash
sudo ln -s /etc/nginx/sites-available/shopify-cancel-app /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx
```

#### Set Up HTTPS with Let's Encrypt

```bash
sudo apt-get install certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com -d www.your-domain.com
```

### Step 8: Admin Panel Access

After deployment, access the admin panel:

1. Navigate to `https://your-app-url.com/admin`
2. Enter the `ADMIN_API_TOKEN` from your `.env`
3. Click **Log in**

From the admin panel you can:

- **Enable/disable automatic refunds** — If disabled, manual approval is required before refunds are issued
- **Configure allowed order statuses** — Choose which fulfillment and financial statuses permit cancellation
- **Approve or deny refunds** — Review pending refund requests (paginated, 25 per page)
- **View cancellation history** — See recent cancellations and their refund status

### Step 9: Testing the End-to-End Flow

Before going live, test the complete cancellation flow:

1. **Access the form**: Visit `https://your-store.myshopify.com/apps/order-cancel`
2. **Submit a test order**: Enter a valid customer email and an existing order number
3. **Check email**: Look for a confirmation email in the inbox (check spam folder if needed)
4. **Click the confirmation link**: The link should be active for the duration set in `CANCEL_TOKEN_TTL_MINUTES`
5. **Verify cancellation**: Check your Shopify admin to confirm the order was cancelled
6. **Check refund status**: If auto-refund is enabled, verify the refund appears in Shopify; if disabled, check the admin panel

### Step 10: Monitoring and Maintenance

#### Check Logs

**Railway:**
- Go to Deployments → Click the deployment → View logs in the console

**Render:**
- Go to Logs tab in the web service dashboard

**VPS with PM2:**
```bash
pm2 logs shopify-cancel-app
```

#### Update Dependencies

Periodically update dependencies for security:

```bash
npm update
npm audit fix
npm start
```

#### Database Maintenance

The app uses SQLite with automatic maintenance. For manual optimization:

```bash
sqlite3 ./data/cancel-requests.db "PRAGMA optimize;"
```

### Troubleshooting

#### "Invalid App Proxy signature" Error

**Cause:** The `SHOPIFY_APP_PROXY_SHARED_SECRET` doesn't match your Shopify app settings.

**Fix:**
1. Go to Shopify Partners → **Configuration** → **App proxy**
2. Copy the exact secret value
3. Update `SHOPIFY_APP_PROXY_SHARED_SECRET` in your `.env`
4. Redeploy the app

#### Emails Not Arriving

**Check:**
1. Verify `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, and `SMTP_PASS` are correct
2. Check the application logs for SMTP errors
3. Ensure your email provider allows SMTP connections from your server's IP
4. Check the spam/junk folder in the test email inbox
5. Try sending a test email first: `npm run test:email` (if implemented)

#### "Order Not Found" Error

**Cause:** The order number doesn't exist or is outside the `ORDER_LOOKBACK_DAYS` window.

**Fix:**
1. Verify the order exists in your Shopify admin
2. Increase `ORDER_LOOKBACK_DAYS` if the order is older
3. Ensure the order's fulfillment and financial statuses are allowed in admin settings

#### Admin Login Fails

**Cause:** The `ADMIN_API_TOKEN` in the browser doesn't match your `.env`.

**Fix:**
1. Verify you entered the correct token on the login page
2. Generate a new token with: `openssl rand -hex 32`
3. Update `ADMIN_API_TOKEN` in your `.env` and redeploy

#### Webhook Signature Invalid

**Cause:** The `SHOPIFY_WEBHOOK_SECRET` doesn't match your webhook secret from Shopify Partners.

**Fix:**
1. Go to Shopify Partners → **Configuration** → **Webhooks**
2. Copy the exact webhook signing secret
3. Update `SHOPIFY_WEBHOOK_SECRET` in `.env`
4. Redeploy and re-test

#### Database Lock Errors

**Cause:** Multiple processes trying to access the SQLite database simultaneously.

**Fix:**
1. Ensure only one instance of the app is running
2. Check PM2 with: `pm2 list`
3. Stop duplicate processes: `pm2 delete shopify-cancel-app`
4. Restart: `pm2 start src/server.js --name "shopify-cancel-app"`

#### High Memory Usage

**Cause:** Large number of pending requests or logs in memory.

**Fix:**
1. Check database size: `ls -lh ./data/cancel-requests.db`
2. Old webhook events are automatically cleaned up after 30 days
3. Monitor with: `pm2 monit`

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `APP_BASE_URL` | Yes | Public URL of the app (e.g. `https://cancel.mystore.com`) |
| `SHOPIFY_STORE_DOMAIN` | Yes | Store domain (e.g. `mystore.myshopify.com`) |
| `SHOPIFY_ADMIN_ACCESS_TOKEN` | Yes | Admin API access token |
| `SHOPIFY_APP_PROXY_SHARED_SECRET` | Yes | App Proxy shared secret |
| `SHOPIFY_WEBHOOK_SECRET` | No | Webhook signature verification secret (generate in Shopify Partners) |
| `SHOPIFY_ADMIN_API_VERSION` | No | API version (defaults to `2026-01`) |
| `SMTP_HOST` | Yes | SMTP server host |
| `SMTP_PORT` | No | SMTP port (defaults to `465`) |
| `SMTP_SECURE` | No | Use TLS (defaults to `true`) |
| `SMTP_USER` | Yes | SMTP username |
| `SMTP_PASS` | Yes | SMTP password |
| `EMAIL_FROM` | Yes | Email sender (e.g. `Store <no-reply@mystore.com>`) |
| `ADMIN_API_TOKEN` | Yes | Token for admin panel access (generate with `openssl rand -hex 32`) |
| `CANCEL_TOKEN_TTL_MINUTES` | No | Confirmation link validity in minutes (defaults to `30`) |
| `CANCEL_NOTIFY_CUSTOMER` | No | Notify customer via Shopify on cancellation (defaults to `true`) |
| `CANCEL_RESTOCK` | No | Restock inventory on cancellation (defaults to `true`) |
| `CANCEL_REFUND` | No | Issue refund when auto-refund is active (defaults to `false`) |
| `ORDER_LOOKBACK_DAYS` | No | Days to look back when searching orders (defaults to `90`) |
| `RATE_LIMIT_WINDOW_MS` | No | Rate limiting window in ms (defaults to `60000`) |
| `RATE_LIMIT_MAX_REQUESTS` | No | Max requests per window (defaults to `5`) |
| `LOG_LEVEL` | No | Log level: `debug`, `info`, `warn`, `error` (defaults to `info`) |
| `DATA_DIR` | No | Directory for SQLite database (defaults to `./data`) |

## Admin Panel

Access `/admin` and enter your `ADMIN_API_TOKEN`.

From the panel you can:

- **Enable/disable automatic refund**: if disabled, cancellations are processed without a refund and require your approval.
- **Configure allowed statuses**: select which fulfillment and financial statuses allow cancellation.
- **Approve or deny refunds**: pending refunds appear in a paginated table with action buttons (25 per page).
- **View recent cancellations**: history of cancellations with their refund status, paginated for easier navigation.

## Features

### Webhooks (v0.6.0+)

The app can optionally listen to Shopify webhooks to sync order state in real-time:

- **orders/updated**: If an order status changes (e.g., fulfillment status) while a cancellation is pending, the pending refund request is automatically denied.
- **orders/cancelled**: If an order is cancelled externally (in Shopify admin or via another app), the database is updated.
- **refunds/create**: If a refund is created externally, the database is updated to reflect the refund status.

Webhooks are verified using HMAC-SHA256 signatures and bypass rate limiting and CSRF checks.

To enable webhooks:

1. Set `SHOPIFY_WEBHOOK_SECRET` in your `.env` (get this from your Shopify Partners app webhook settings)
2. Register these webhook endpoints in Shopify Partners:
   - POST `/webhooks/orders/updated`
   - POST `/webhooks/orders/cancelled`
   - POST `/webhooks/refunds/create`

### Email Retry Queue (v0.6.0+)

The app includes a background email retry worker that automatically retries failed confirmation emails:

- Runs every 60 seconds
- Tracks email send attempts (up to 5 retries)
- Uses exponential backoff (1s, 2s, 4s, 8s, 16s)
- Logs failures with attempt counts
- Gracefully shuts down on process termination

If an email fails to send, the customer sees "Check your email" regardless, and the app will retry automatically in the background.

### Admin Panel Pagination (v0.6.0+)

The admin panel tables are now paginated (25 rows per page) for better performance with large datasets:

- **Pending Refunds**: Browse pending approvals across multiple pages
- **Recent Cancellations**: View cancellation history with pagination controls
- Page navigation via Previous/Next buttons with current page indicator

## Shopify Configuration

### App Proxy

Configure an App Proxy in your Shopify Partners app pointing to your server:

- **Subpath prefix**: `apps`
- **Subpath**: `cancel`
- **Proxy URL**: `https://your-domain.com`

### API Permissions

The app requires the following scopes:

- `read_orders` — search orders by email and number
- `write_orders` — cancel orders, update notes, manage tags

### Webhooks (optional)

For real-time sync, create these webhooks in Shopify Partners:

- `orders/updated` → `https://your-domain.com/webhooks/orders/updated`
- `orders/cancelled` → `https://your-domain.com/webhooks/orders/cancelled`
- `refunds/create` → `https://your-domain.com/webhooks/refunds/create`

Get the webhook secret from Shopify and add it to `SHOPIFY_WEBHOOK_SECRET` in `.env`.

## Project Structure

```
src/
  server.js        Express server with all routes
  shopify.js       Shopify GraphQL client (cancel, refund, tags, notes)
  storage.js       SQLite database (requests, admin settings, pagination, email queue)
  config.js        Configuration with environment variable validation
  appProxy.js      App Proxy HMAC verification
  adminAuth.js     Admin authentication (opaque server-side sessions)
  csrf.js          CSRF protection (double-submit cookie)
  rateLimit.js     In-memory rate limiting (sliding window)
  email.js         Email sending with retry and exponential backoff
  emailQueue.js    Background email retry worker (60-second intervals)
  webhooks.js      Shopify webhook handlers (HMAC-SHA256 verification)
  logger.js        Structured JSON logging + audit trail
  utils.js         Helpers (normalization, hashing, validation, escaping)
views/
  form.html        Cancellation form
  admin.html       Admin dashboard with pagination
  success.html     Successful confirmation page
  request-sent.html  Email sent page
```

## Shopify API Usage

The app uses the Admin GraphQL API (`2026-01`):

- `orderCancel` — cancels the order with `refundMethod` (replaces the deprecated `refund: Boolean`)
- `refundCreate` with `@idempotent(key:)` directive — creates refunds safely and idempotently
- `suggestedRefund` — calculates correct refund amounts
- `tagsAdd` / `tagsRemove` — tags orders with `refund-pending` during manual approval
- `orderUpdate` — updates the order's internal note with refund status

## Security

- HMAC-SHA256 verification of all App Proxy requests
- CSRF protection on all state-changing endpoints (forms + admin panel)
- Rate limiting by IP and by email address
- Admin sessions with opaque tokens (the actual token is never stored in cookies)
- Confirmation tokens hashed with SHA-256 in the database
- Timing-safe comparisons across all authentication and CSRF validation
- Security headers: CSP, X-Frame-Options, X-Content-Type-Options, HSTS, Referrer-Policy
- Request body size limit (10KB)
- Prepared statements for all SQLite queries (WAL mode)
- Strict input validation (email, order number, settings)

## License

MIT
