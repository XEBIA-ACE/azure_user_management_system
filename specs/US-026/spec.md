# Feature Specification: US-026 — Notification of Account Status Change

Spec bundle `f8c1f74c-bb37-4f7e-8e2a-a65e6a0cfe76` · Spec Agent run `4da16be1-d2ca-58a1-8356-68b9694432f5` · Content hash `sha256:42a6cf7bfaf99d186f0fe97d8869d2b64c8e6cd960abe63c109fe7824d02fafb`

## User Scenarios & Testing
- A user's account is activated, deactivated, reactivated or otherwise changes status → the user receives an email at their registered address.
- The same status is submitted again, the update fails, or the caller is unauthorized → no email is sent.
- The email provider is temporarily unavailable → the status change still succeeds; delivery is retried; a permanent failure is recorded for monitoring.

## Functional Requirements
- **FR-001**: An email notification must be sent to users when their account status changes, including activation, deactivation, or reactivation.
- **FR-002**: Dispatch within 10 seconds of the status change being committed; normal delivery within 60 seconds.
- **FR-003**: Asynchronous email processing so delivery never delays or rolls back the status update; retry temporary failures.
- **FR-004**: No duplicate notifications for the same status-change event; notify only on an actual status change.

## Success Criteria
- **US-026-ac-1** (`US-026-AC1`): Users receive an email notification when their account status changes.
  Test obligation `4da16be1-d2ca-58a1-8356-68b9694432f5:test:acceptance:US-026-ac-1`.
- **US-026-ac-2** (`US-026-AC2`): Notifications are sent promptly following a status change.
  Test obligation `4da16be1-d2ca-58a1-8356-68b9694432f5:test:acceptance:US-026-ac-2`.
- **DOD-1**: Email templates reviewed and approved — **NOT MET** (drafts only, see GAP-US026-TEMPLATE-APPROVAL).
- **DOD-2**: Notification system integrated — **PARTIAL** (module + ports delivered; no running service to integrate into, see GAP-US026-NO-SERVICE).
- **DOR-1**: Requirements approved — per spec bundle.
- **DOR-2**: Notification templates ready — **NOT MET** (see GAP-US026-TEMPLATE-APPROVAL).

## Contracts

### Event: `account-status-change` (publishes)
Defined in `src/notifications/account-status/contracts.ts` (`AccountStatusChangedEvent`), schema version `1`:

| Field | Type | Notes |
|---|---|---|
| `eventId` | string (UUID) | Unique per change; idempotency / de-duplication key |
| `topic` | `"account-status-change"` | |
| `schemaVersion` | `1` | |
| `userId` | string | |
| `previousStatus` | string | |
| `newStatus` | string | normalized lowercase |
| `changedAt` | ISO-8601 string | commit time |

The event intentionally carries **no email address or other PII**; the registered email is read from the user store at send time.

### Data
- **User account status data** — `UserRecord.status`; updated by `UserRepository.updateStatusAndEnqueue` with an optimistic `expectedPreviousStatus` check, in the same transaction as the outbox insert.
- **Email address data** — `UserRecord.email` (registered address). Logged only in masked form (`j***@example.com`).
- **Outbox** — `OutboxEntry { event, state: pending|sent|failed, attempts, nextAttemptAt, lastError }`, unique on `eventId`.

### API: `POST user-account-status`
**Not implemented** — no HTTP layer exists in the repository (GAP-US026-NO-SERVICE). The framework-agnostic entry point is `AccountStatusService.changeStatus(actor, userId, newStatus)`; an HTTP controller should map:
`ForbiddenError` → 403, `NotFoundError` → 404, `ConflictError` → 409, `TypeError` → 400, `{changed:false}` → 200 (no-op).

## Error handling
| Situation | Behaviour |
|---|---|
| Caller lacks `account:status:write` | `ForbiddenError`; nothing persisted or sent |
| Same status submitted | `{ changed: false, reason: 'unchanged' }`; no event |
| User missing / concurrent change / commit fails | Error thrown; no event enqueued |
| Transient transport error | Retry with exponential backoff (`2s · 2^(n-1)`), up to `maxAttempts` (default 5); `warn` log |
| `PermanentEmailError` or attempts exhausted | Outbox entry `failed` + `lastError`; `error` log for monitoring; status **not** reverted |
| User/email missing at send time | Entry `failed`; `error` log |
| Crash after send but before `markSent` | Event may be re-sent (at-least-once); `idempotencyKey = eventId` lets the provider drop it |

## Templates (DRAFT — pending approval)
`src/notifications/account-status/templates.ts`: `account-activated`, `account-deactivated`, `account-status-changed`, each with subject, responsive HTML (`lang`, viewport, `role="presentation"` layout tables, real heading, `th scope="row"`) and plain text. Content is data (`defaultTemplates`) and can be replaced via `TemplateRenderer({ templates })` without touching business logic. Branding: `appName`, optional `supportContact`.

## Known gaps (disclosed, not worked around)
- **GAP-NO-CODEBASE-EVIDENCE** (from bundle, high): the spec was generated without codebase analysis. Confirmed: see below.
- **GAP-US026-NO-SERVICE** (high): The repository contains no application code — only the unimplemented `SCAFFOLD-SVC-001` / `SCAFFOLD-frontend-app` specs. The "existing" User Management Service, Users Repository, Account Status Management API/Service and SMTP/transactional email service named in the team decisions **do not exist**. Delivered as a self-contained module with ports (`UserRepository`, `OutboxStore`, `EmailTransport`) and an in-memory reference adapter; it must be wired into the service once `SCAFFOLD-SVC-001` lands.
- **GAP-US026-DB-MISMATCH** (medium): Team decision references a *SQLite* users DB; `SCAFFOLD-SVC-001` specifies *PostgreSQL* (with an outbox table). Needs a decision; the ports are datastore-agnostic.
- **GAP-US026-NO-PERSISTENCE** (high): No database adapter for users/outbox — needs a migration (outbox table, unique `eventId`, index on `(state, next_attempt_at)`) and a `SELECT … FOR UPDATE SKIP LOCKED` (or equivalent) claim.
- **GAP-US026-NO-EMAIL-TRANSPORT** (high): No SMTP/transactional email integration exists to reuse. An approved provider/adapter implementing `EmailTransport` is required (without reintroducing the deprecated OTP workflow). Until then nothing is actually delivered, so the 60 s delivery target (FR-002) cannot be verified.
- **GAP-US026-TEMPLATE-APPROVAL** (blocking for release): Team decision says templates "must be reviewed and approved before implementation". The templates here are drafts for that review; DOD-1/DOR-2 are not met.
- **GAP-US026-STATUS-MODEL** (medium): No account status model exists. `active`/`inactive` are assumed (mapped to Activated/Deactivated templates); other values use the generic template. The scaffold spec's `verified_at` / self-delete semantics are not mapped to statuses — needs confirmation.
- **GAP-US026-AUTHZ** (medium): No auth/role model exists. A permission string `account:status:write` is assumed.
- **GAP-US026-SUPPORT-CONTACT**: Support contact / recovery instructions for the deactivation email are not specified; configurable via `branding.supportContact` (omitted when empty).
- **GAP-US026-NO-CI**: No test commands are declared (darkfactory.yml) and no CI exists; `npm test` was added but is not run by the platform.

## Provenance
- **Policy version**: `ace-spec-format/v1`
- **Repository baseline commit**: `181251f152ed628d33e05bf727eed591dc9a0794`
