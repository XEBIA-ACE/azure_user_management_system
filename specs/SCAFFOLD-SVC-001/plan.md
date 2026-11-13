# Implementation Plan: SCAFFOLD-SVC-001

## Technical Context
- Technology stack: Node.js (TypeScript), NestJS (or Fastify/Express), PostgreSQL (users/otp/sessions/outbox), Prisma (or TypeORM) + migrations, Argon2id password hashing, JWT access tokens + refresh tokens (rotation) OR opaque sessions (DB-backed), SMTP client library (adapter) for email sending via provider, In-process or separate-process worker from same codebase for outbox processing, problem+json (RFC 9457) error responses, OpenAPI/Swagger for API documentation.
- Platform: backend.
- Set up the project skeleton for this stack: dependency manifest, entrypoint, and linting/formatting config.
- Add environment-based configuration loading (no hardcoded secrets or endpoints).
- Add a health-check endpoint so the service can be verified as running locally.
- Add a database connection helper for the stack's datastore, configured via environment variables.

## Contract Changes
- No material API, event, or data contract change is evidenced.

## Security and Quality
- Validate credential and personal-data handling against the story's acceptance criteria
- The scaffolded service must start successfully and its health-check endpoint must respond, using only environment-based configuration.

## Verification Plan
- **AC-1**: Scaffold the User Management System (UMS) - Modular Monolith (business) per its approved architecture. Technology stack: Node.js (TypeScript), NestJS (or Fastify/Express), PostgreSQL (users/otp/sessions/outbox), Prisma (or TypeORM) + migrations, Argon2id password hashing, JWT access tokens + refresh tokens (rotation) OR opaque sessions (DB-backed), SMTP client library (adapter) for email sending via provider, In-process or separate-process worker from same codebase for outbox processing, problem+json (RFC 9457) error responses, OpenAPI/Swagger for API documentation. Responsibilities: Register users with unique normalized email, store profile (name/email) and secure password hash; Generate and persist OTP challenges (hashed), enforce 5-minute expiry, single-use consumption, and bounded attempts; Send OTP emails asynchronously via transactional outbox + worker with retries/backoff and idempotency; Verify OTP to activate/mark user as verified (set verified_at) and ensure deterministic outcomes for retries; Authenticate users with email/password only if verified and not deleted; issue and validate access tokens/sessions; Authorize protected routes by enforcing Verified + NotDeleted policies consistently; Allow authenticated users to self-delete accounts; revoke sessions/tokens and enforce post-deletion access denial; Apply brute-force protections/rate limiting for OTP verification and login endpoints (in-app; optional Redis for multi-instance); Provide consistent problem+json error contracts and API versioning under /v1; Emit structured logs/metrics with correlation IDs for API and worker flows (without logging secrets/OTPs). Ground the generated spec in this service's own C3/C4 diagrams and API spec already on file in Architecture, not just this summary.