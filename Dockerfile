# ── Stage 1: Install dependencies ─────────────────────────────────────
FROM node:20-alpine AS deps

WORKDIR /app

# Install build tools for native modules (better-sqlite3)
RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ── Stage 2: Production image ────────────────────────────────────────
FROM node:20-alpine AS production

# Security: install curl for healthcheck, then create non-root user
RUN apk add --no-cache curl \
    && addgroup -g 1001 -S appgroup \
    && adduser -u 1001 -S appuser -G appgroup

WORKDIR /app

# Copy production dependencies from deps stage
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/package.json ./package.json

# Copy application source
COPY src/ ./src/
COPY views/ ./views/

# Create data directory with correct permissions
RUN mkdir -p /app/data && chown -R appuser:appgroup /app/data

ENV NODE_ENV=production
ENV DATA_DIR=/app/data

# Switch to non-root user
USER appuser

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:3000/health || exit 1

CMD ["node", "src/server.js"]
