# Implementation Plan: US-026

## Technical Context
- Stack per `SCAFFOLD-SVC-001`: Node.js (TypeScript). The service skeleton does not exist yet, so this story is delivered as a dependency-free module in `src/notifications/account-status/` using Node's built-in type stripping (Node >= 22.18) and `node:test`.
- Pattern: **transactional outbox** (matches SCAFFOLD-SVC-001's "outbox + worker with retries/backoff and idempotency").
  1. `AccountStatusService.changeStatus` — authorize → load user → no-op if unchanged → update status + insert `account-status-change` event atomically → wake dispatcher.
  2. `AccountStatusNotificationDispatcher` — claims due outbox entries (immediate wake-up + 1 s fallback poll), resolves registered email, renders template, sends via `EmailTransport`, marks sent / schedules retry / marks failed.
  3. `TemplateRenderer` + `defaultTemplates` — configurable HTML + text templates.

## Contract Changes
- New event contract `account-status-change` v1 (see spec.md).
- New ports `UserRepository.updateStatusAndEnqueue`, `OutboxStore`, `EmailTransport`.
- API `POST user-account-status` — deferred until an HTTP layer exists (GAP-US026-NO-SERVICE).

## Security and Quality
- Only actors with `account:status:write` can change status.
- No PII in events; email addresses masked in logs; no passwords/tokens in templates; HTML-escaping of all interpolated values.
- Status change never blocked or rolled back by email delivery.

## Verification Plan
- **US-026-ac-1** → `test/notifications/account-status.test.ts`, suite `[US-026-AC1]`.
- **US-026-ac-2** → `test/notifications/account-status.test.ts`, suite `[US-026-AC2]` (immediate dispatch < 10 s, fallback poll, non-blocking, retry/backoff, permanent failure, de-duplication).
- Run: `npm test`.
- Not verifiable here: real delivery within 60 s (no transport — GAP-US026-NO-EMAIL-TRANSPORT).
