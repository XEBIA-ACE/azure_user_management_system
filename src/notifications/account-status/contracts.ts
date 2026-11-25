/**
 * US-026 — Notification of Account Status Change: contracts.
 *
 * Event contract for topic `account-status-change` (spec touchpoint
 * `kind: event, direction: publishes`). The event deliberately carries no
 * email address or other personal data: the registered email address is
 * resolved from the user repository at send time (team decision: "Protect
 * user email addresses and personal information").
 */

export const ACCOUNT_STATUS_CHANGE_TOPIC = 'account-status-change';
export const ACCOUNT_STATUS_CHANGE_SCHEMA_VERSION = 1;

/**
 * Known account statuses. Kept as an open string type because the
 * repository does not yet define a status model (see specs/US-026/spec.md,
 * GAP-US026-STATUS-MODEL). `active`/`inactive` map to the Activated /
 * Deactivated templates; any other transition uses the generic template.
 */
export const AccountStatus = {
  ACTIVE: 'active',
  INACTIVE: 'inactive',
} as const;
export type AccountStatus = string;

export interface AccountStatusChangedEvent {
  /** Unique per status change; used as the idempotency / de-duplication key (FR-004). */
  eventId: string;
  topic: typeof ACCOUNT_STATUS_CHANGE_TOPIC;
  schemaVersion: typeof ACCOUNT_STATUS_CHANGE_SCHEMA_VERSION;
  userId: string;
  previousStatus: AccountStatus;
  newStatus: AccountStatus;
  /** ISO-8601 timestamp at which the change was committed. */
  changedAt: string;
}

export interface UserRecord {
  id: string;
  /** Registered email address associated with the account. */
  email: string;
  displayName?: string;
  status: AccountStatus;
}

/** Caller performing the status change. */
export interface Actor {
  id: string;
  permissions: readonly string[];
}

export const PERMISSION_CHANGE_ACCOUNT_STATUS = 'account:status:write';

/**
 * Persistence port. `updateStatusAndEnqueue` MUST update the user's status
 * and append the event to the outbox in a single transaction, and only when
 * the stored status still equals `expectedPreviousStatus` (optimistic check).
 * Returns false when nothing was updated (concurrent change / user missing),
 * in which case no event may be enqueued.
 */
export interface UserRepository {
  findById(userId: string): Promise<UserRecord | undefined>;
  updateStatusAndEnqueue(
    userId: string,
    expectedPreviousStatus: AccountStatus,
    event: AccountStatusChangedEvent,
  ): Promise<boolean>;
}

export type OutboxState = 'pending' | 'sent' | 'failed';

export interface OutboxEntry {
  event: AccountStatusChangedEvent;
  state: OutboxState;
  attempts: number;
  /** Epoch ms after which the entry may be (re)tried. */
  nextAttemptAt: number;
  lastError?: string;
}

/** Transactional outbox port read by the dispatcher. */
export interface OutboxStore {
  /** Atomically claims up to `limit` due pending entries (no double-claim). */
  claimDue(now: number, limit: number): Promise<OutboxEntry[]>;
  markSent(eventId: string): Promise<void>;
  scheduleRetry(eventId: string, attempts: number, nextAttemptAt: number, error: string): Promise<void>;
  markFailed(eventId: string, attempts: number, error: string): Promise<void>;
}

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Stable key so a transport/provider can de-duplicate re-sends. */
  idempotencyKey: string;
}

/** Transactional email transport port (SMTP adapter, provider API, ...). */
export interface EmailTransport {
  send(message: EmailMessage): Promise<void>;
}

/** Thrown by transports for failures that must not be retried (e.g. invalid recipient). */
export class PermanentEmailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentEmailError';
  }
}

export class ForbiddenError extends Error {
  constructor(message = 'Not authorized to change account status') {
    super(message);
    this.name = 'ForbiddenError';
  }
}

export class NotFoundError extends Error {
  constructor(message = 'User not found') {
    super(message);
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends Error {
  constructor(message = 'Account status was changed concurrently') {
    super(message);
    this.name = 'ConflictError';
  }
}

export interface Logger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export const silentLogger: Logger = { info() {}, warn() {}, error() {} };

/** Masks an email for logs: `jane.doe@example.com` -> `j***@example.com`. */
export function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return '***';
  return `${email[0]}***${email.slice(at)}`;
}
