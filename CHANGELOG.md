# Changelog

All notable changes to the Shopify Order Cancel App are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

---

## [1.2.0] - 2026-03-30

### Fixed
- Standalone cancellation form (`form.html`) now posts to `/proxy/request` instead of `/apps/order-cancel/request`, which only worked through the Shopify App Proxy

### Changed
- Complete redesign of all frontend views (cancellation form, confirmation page, success/error pages) and email template with a professional, modern look
- Updated README to document the `e2e-confirm` test suite

---

## [1.1.0] - 2026-03-30

### Added
- Shopify App Proxy integration for in-theme cancellation form at `/apps/order-cancel/cancel-order`
- E2E confirmation tests (`e2e-confirm.test.js`) covering token validation, order re-verification, auto-refund and manual-refund paths
- SQLite3 CLI and backup/restore scripts included in the Docker image

### Changed
- Rewrote README with Docker-first operations guide and comprehensive from-scratch installation instructions
- Updated all dependencies to latest major versions
- Patched Alpine zlib and stripped npm from production Docker image to resolve Trivy CVE scan findings

### Fixed
- Removed extra-scope GraphQL fields that were not available with `read_orders` access
- Fixed proxy form action path for App Proxy submissions
- Fixed Docker Publish CI workflow: separated single-platform scan from multi-platform push

### Security
- Hardened CSP headers, CSRF protection, and rate limiting
- Added HMAC signature and timestamp verification for App Proxy requests

---

## [1.0.0] - 2026-03-30

### Added
- Multi-stage Dockerfile and `docker-compose.yml` for local development with Mailpit
- Vitest + Supertest + MSW test infrastructure with 49 P0/P1 tests across 8 test suites
- Docker multi-arch build and publish to GHCR on push to main (CI)
- Test step added to CI pipeline
- Infrastructure resource limits and CVE vulnerability scanning in CI

### Changed
- Extracted `app.js` from `server.js` for testability
- Extracted views into separate HTML templates, unified session handling
- Added error monitoring and backup utilities (Phase 3 refactor)
- Rewrote README with comprehensive setup, architecture, security, and deployment guide

### Security
- Hashed `ADMIN_API_TOKEN` at startup to protect against memory dumps
- Upgraded Nodemailer to 8.0.4 to resolve high-severity vulnerabilities

### Fixed
- Removed `COPY public/` from Dockerfile — directory does not exist
- Removed unused imports (`findRequestById`, `findRequestByTokenHash`)
- Updated Node.js CI matrix to 20/22 (ESLint 10 requires Node 20+)

---

## [0.9.0] - 2026-03-29

### Changed
- Redesigned frontend with new visual identity and CSP support for external fonts

### Fixed
- Audit fixes #10 through #14: security hardening, input validation, error handling, and edge case fixes (v0.8.6–v0.9.0)
- Phase 1 audit fixes: security improvements, CI pipeline fixes, and tooling updates (v0.10.0)
