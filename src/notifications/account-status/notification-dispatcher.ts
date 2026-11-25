/**
 * US-026 — Account Status Notification Dispatcher (asynchronous email
 * processing / notification event handler).
 *
 * Drains the `account-status-change` outbox and sends the matching email to
 * the user's registered address.
 *
 * - Prompt (FR-002): `kick()` is invoked right after the status change commits,
 *   so dispatch normally starts within milliseconds; a fallback poll (default
 *   1 s) guarantees pick-up well inside the 10 s dispatch budget even if the
 *   wake-up signal is lost (e.g. the change was made by another process).
 * - Retries (FR-003): transient transport errors are retried with exponential
 *   backoff up to `maxAttempts`; then the entry is marked `failed` and logged
 *   for monitoring. The account status is never reverted.
 * - De-duplication (FR-004): each event is claimed atomically from the outbox
 *   and marked `sent` once; the eventId is passed to the transport as an
 *   idempotency key so a provider can also drop re-sends.
 */

import {
  type EmailTransport,
  type Logger,
  maskEmail,
  type OutboxEntry,
  type OutboxStore,
  PermanentEmailError,
  silentLogger,
  type UserRepository,
} from './contracts.ts';
import type { TemplateRenderer } from './templates.ts';

export interface DispatcherOptions {
  outbox: OutboxStore;
  users: Pick<UserRepository, 'findById'>;
  transport: EmailTransport;
  renderer: TemplateRenderer;
  logger?: Logger;
  now?: () => number;
  /** Fallback polling interval in ms (default 1000). */
  pollIntervalMs?: number;
  /** Total send attempts per event including the first (default 5). */
  maxAttempts?: number;
  /** Base backoff in ms; delay = base * 2^(attempt-1) (default 2000). */
  retryBaseDelayMs?: number;
  /** Max entries claimed per drain cycle (default 50). */
  batchSize?: number;
}

export class AccountStatusNotificationDispatcher {
  readonly #outbox: OutboxStore;
  readonly #users: Pick<UserRepository, 'findById'>;
  readonly #transport: EmailTransport;
  readonly #renderer: TemplateRenderer;
  readonly #logger: Logger;
  readonly #now: () => number;
  readonly #pollIntervalMs: number;
  readonly #maxAttempts: number;
  readonly #retryBaseDelayMs: number;
  readonly #batchSize: number;

  #timer: ReturnType<typeof setInterval> | undefined;
  #draining: Promise<void> | undefined;
  #rerun = false;

  constructor(options: DispatcherOptions) {
    this.#outbox = options.outbox;
    this.#users = options.users;
    this.#transport = options.transport;
    this.#renderer = options.renderer;
    this.#logger = options.logger ?? silentLogger;
    this.#now = options.now ?? Date.now;
    this.#pollIntervalMs = options.pollIntervalMs ?? 1000;
    this.#maxAttempts = options.maxAttempts ?? 5;
    this.#retryBaseDelayMs = options.retryBaseDelayMs ?? 2000;
    this.#batchSize = options.batchSize ?? 50;
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => this.kick(), this.#pollIntervalMs);
    this.#timer.unref?.();
    this.kick();
  }

  async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#draining;
  }

  /** Requests an immediate drain without blocking the caller. */
  kick(): void {
    void this.drain().catch((err) => this.#logger.error('notification drain failed', { error: String(err) }));
  }

  /** Processes all currently due outbox entries. Concurrent calls coalesce. */
  drain(): Promise<void> {
    if (this.#draining) {
      this.#rerun = true;
      return this.#draining;
    }
    this.#draining = (async () => {
      try {
        do {
          this.#rerun = false;
          let batch: OutboxEntry[];
          do {
            batch = await this.#outbox.claimDue(this.#now(), this.#batchSize);
            for (const entry of batch) await this.#process(entry);
          } while (batch.length === this.#batchSize);
        } while (this.#rerun);
      } finally {
        this.#draining = undefined;
      }
    })();
    return this.#draining;
  }

  async #process(entry: OutboxEntry): Promise<void> {
    const { event } = entry;
    const attempt = entry.attempts + 1;

    const user = await this.#users.findById(event.userId);
    if (!user || !user.email) {
      await this.#outbox.markFailed(event.eventId, attempt, 'user or registered email not found');
      this.#logger.error('account status notification failed permanently', {
        eventId: event.eventId,
        userId: event.userId,
        reason: 'user or registered email not found',
      });
      return;
    }

    const rendered = this.#renderer.render(event, user);
    try {
      await this.#transport.send({
        to: user.email,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        idempotencyKey: event.eventId,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const permanent = err instanceof PermanentEmailError;
      if (permanent || attempt >= this.#maxAttempts) {
        await this.#outbox.markFailed(event.eventId, attempt, message);
        this.#logger.error('account status notification failed permanently', {
          eventId: event.eventId,
          userId: event.userId,
          to: maskEmail(user.email),
          attempts: attempt,
          error: message,
        });
      } else {
        const delay = this.#retryBaseDelayMs * 2 ** (attempt - 1);
        await this.#outbox.scheduleRetry(event.eventId, attempt, this.#now() + delay, message);
        this.#logger.warn('account status notification send failed; will retry', {
          eventId: event.eventId,
          userId: event.userId,
          attempts: attempt,
          retryInMs: delay,
          error: message,
        });
      }
      return;
    }

    await this.#outbox.markSent(event.eventId);
    this.#logger.info('account status notification sent', {
      eventId: event.eventId,
      userId: event.userId,
      to: maskEmail(user.email),
      template: rendered.templateId,
      dispatchLatencyMs: this.#now() - Date.parse(event.changedAt),
    });
  }
}
