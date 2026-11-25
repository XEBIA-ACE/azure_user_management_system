/**
 * US-026 — Account Status Management Service.
 *
 * Changes a user's account status and, in the same transaction, enqueues an
 * `account-status-change` event in the outbox (transactional outbox). The
 * email itself is sent asynchronously by `AccountStatusNotificationDispatcher`,
 * so email delivery can never delay or roll back the status update (FR-003).
 *
 * - No event is produced when the requested status equals the current one,
 *   or when the update fails (FR-004, team decision).
 * - Only actors holding `account:status:write` may change status.
 */

import { randomUUID } from 'node:crypto';
import {
  ACCOUNT_STATUS_CHANGE_SCHEMA_VERSION,
  ACCOUNT_STATUS_CHANGE_TOPIC,
  type AccountStatus,
  type AccountStatusChangedEvent,
  type Actor,
  ConflictError,
  ForbiddenError,
  type Logger,
  NotFoundError,
  PERMISSION_CHANGE_ACCOUNT_STATUS,
  silentLogger,
  type UserRepository,
} from './contracts.ts';

export type ChangeStatusResult =
  | { changed: true; event: AccountStatusChangedEvent }
  | { changed: false; reason: 'unchanged' };

export interface AccountStatusServiceOptions {
  users: UserRepository;
  /** Called after a successful commit to wake the dispatcher immediately (FR-002). */
  onCommitted?: (event: AccountStatusChangedEvent) => void;
  now?: () => Date;
  newId?: () => string;
  logger?: Logger;
}

export class AccountStatusService {
  readonly #users: UserRepository;
  readonly #onCommitted: (event: AccountStatusChangedEvent) => void;
  readonly #now: () => Date;
  readonly #newId: () => string;
  readonly #logger: Logger;

  constructor(options: AccountStatusServiceOptions) {
    this.#users = options.users;
    this.#onCommitted = options.onCommitted ?? (() => {});
    this.#now = options.now ?? (() => new Date());
    this.#newId = options.newId ?? randomUUID;
    this.#logger = options.logger ?? silentLogger;
  }

  async changeStatus(actor: Actor, userId: string, newStatus: AccountStatus): Promise<ChangeStatusResult> {
    if (!actor.permissions.includes(PERMISSION_CHANGE_ACCOUNT_STATUS)) {
      throw new ForbiddenError();
    }
    const status = newStatus.trim().toLowerCase();
    if (!status) throw new TypeError('newStatus must be a non-empty string');

    const user = await this.#users.findById(userId);
    if (!user) throw new NotFoundError();

    if (user.status === status) {
      return { changed: false, reason: 'unchanged' };
    }

    const event: AccountStatusChangedEvent = {
      eventId: this.#newId(),
      topic: ACCOUNT_STATUS_CHANGE_TOPIC,
      schemaVersion: ACCOUNT_STATUS_CHANGE_SCHEMA_VERSION,
      userId,
      previousStatus: user.status,
      newStatus: status,
      changedAt: this.#now().toISOString(),
    };

    const committed = await this.#users.updateStatusAndEnqueue(userId, user.status, event);
    if (!committed) throw new ConflictError();

    this.#logger.info('account status changed', {
      eventId: event.eventId,
      userId,
      actorId: actor.id,
      previousStatus: event.previousStatus,
      newStatus: event.newStatus,
    });

    try {
      this.#onCommitted(event);
    } catch (err) {
      // Waking the dispatcher is best-effort; the outbox poll still picks it up.
      this.#logger.warn('failed to signal notification dispatcher', { eventId: event.eventId, error: String(err) });
    }
    return { changed: true, event };
  }
}
