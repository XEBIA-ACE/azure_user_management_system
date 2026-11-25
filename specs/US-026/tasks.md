# Tasks: US-026

- [x] T001 Define `account-status-change` event contract and persistence/transport ports.
- [x] T002 Account status service: authorization, no-op on unchanged status, atomic status update + outbox enqueue (US-026-ac-1, FR-004).
- [x] T003 Asynchronous dispatcher with immediate wake-up, fallback poll, retry/backoff, failure recording, de-duplication (US-026-ac-2, FR-002, FR-003, FR-004).
- [x] T004 Draft Activated / Deactivated / Status Changed templates (HTML + text, configurable).
- [x] T005 Tests tagged `[US-026-AC1]` / `[US-026-AC2]`.
- [ ] T006 Template review and approval (DOD-1, DOR-2) — **pending**.
- [ ] T007 Database adapter + migration for users/outbox (blocked on SCAFFOLD-SVC-001 and SQLite vs PostgreSQL decision).
- [ ] T008 Approved transactional email adapter implementing `EmailTransport`.
- [ ] T009 `POST user-account-status` HTTP endpoint and dispatcher start-up in the service (blocked on SCAFFOLD-SVC-001).
- [ ] T010 Confirm account status model and authorization model.
