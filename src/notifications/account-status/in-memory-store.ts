/**
 * In-memory reference adapter implementing both `UserRepository` and
 * `OutboxStore` with the same atomicity guarantees a real database adapter
 * must provide (status update + outbox insert in one transaction, unique
 * eventId, atomic claim). Used by tests and as the reference for the future
 * database adapter (see GAP-US026-NO-PERSISTENCE in specs/US-026/spec.md).
 */

import type {
  AccountStatus,
  AccountStatusChangedEvent,
  OutboxEntry,
  OutboxStore,
  UserRecord,
  UserRepository,
} from './contracts.ts';

type InternalEntry = OutboxEntry & { claimed: boolean };

export class InMemoryUserStore implements UserRepository, OutboxStore {
  readonly #users = new Map<string, UserRecord>();
  readonly #outbox = new Map<string, InternalEntry>();

  seed(user: UserRecord): void {
    this.#users.set(user.id, { ...user });
  }

  async findById(userId: string): Promise<UserRecord | undefined> {
    const u = this.#users.get(userId);
    return u ? { ...u } : undefined;
  }

  async updateStatusAndEnqueue(
    userId: string,
    expectedPreviousStatus: AccountStatus,
    event: AccountStatusChangedEvent,
  ): Promise<boolean> {
    const user = this.#users.get(userId);
    if (!user || user.status !== expectedPreviousStatus) return false;
    if (this.#outbox.has(event.eventId)) return false; // unique eventId
    user.status = event.newStatus;
    this.#outbox.set(event.eventId, {
      event: { ...event },
      state: 'pending',
      attempts: 0,
      nextAttemptAt: 0,
      claimed: false,
    });
    return true;
  }

  async claimDue(now: number, limit: number): Promise<OutboxEntry[]> {
    const due: OutboxEntry[] = [];
    for (const entry of this.#outbox.values()) {
      if (due.length >= limit) break;
      if (entry.state === 'pending' && !entry.claimed && entry.nextAttemptAt <= now) {
        entry.claimed = true;
        due.push({ event: { ...entry.event }, state: entry.state, attempts: entry.attempts, nextAttemptAt: entry.nextAttemptAt });
      }
    }
    return due;
  }

  async markSent(eventId: string): Promise<void> {
    const e = this.#require(eventId);
    e.state = 'sent';
    e.attempts += 1;
    e.claimed = false;
  }

  async scheduleRetry(eventId: string, attempts: number, nextAttemptAt: number, error: string): Promise<void> {
    const e = this.#require(eventId);
    Object.assign(e, { attempts, nextAttemptAt, lastError: error, claimed: false });
  }

  async markFailed(eventId: string, attempts: number, error: string): Promise<void> {
    const e = this.#require(eventId);
    Object.assign(e, { state: 'failed', attempts, lastError: error, claimed: false });
  }

  /** Test/ops helper: snapshot of outbox entries. */
  entries(): OutboxEntry[] {
    return [...this.#outbox.values()].map(({ claimed: _c, ...rest }) => ({ ...rest, event: { ...rest.event } }));
  }

  #require(eventId: string): InternalEntry {
    const e = this.#outbox.get(eventId);
    if (!e) throw new Error(`unknown outbox entry ${eventId}`);
    return e;
  }
}
