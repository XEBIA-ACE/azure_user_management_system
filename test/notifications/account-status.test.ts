/**
 * US-026 — Notification of Account Status Change.
 *
 * Test obligations:
 *  - 4da16be1-d2ca-58a1-8356-68b9694432f5:test:acceptance:US-026-ac-1
 *  - 4da16be1-d2ca-58a1-8356-68b9694432f5:test:acceptance:US-026-ac-2
 * Also covers FR-001..FR-004, unit/integration and email-delivery-failure
 * cases required by the team decisions.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  AccountStatusNotificationDispatcher,
  AccountStatusService,
  type Actor,
  type AccountStatusChangedEvent,
  ConflictError,
  createAccountStatusNotifications,
  type EmailMessage,
  type EmailTransport,
  ForbiddenError,
  InMemoryUserStore,
  type Logger,
  NotFoundError,
  PERMISSION_CHANGE_ACCOUNT_STATUS,
  PermanentEmailError,
  TemplateRenderer,
  defaultTemplates,
  maskEmail,
} from '../../src/notifications/account-status/index.ts';

const admin: Actor = { id: 'admin-1', permissions: [PERMISSION_CHANGE_ACCOUNT_STATUS] };
const branding = { appName: 'User Management', supportContact: 'support@example.com' };

class RecordingTransport implements EmailTransport {
  sent: EmailMessage[] = [];
  failuresBeforeSuccess = 0;
  permanentFailure = false;
  delayMs = 0;
  calls = 0;
  #waiters: Array<() => void> = [];

  async send(message: EmailMessage): Promise<void> {
    this.calls++;
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    if (this.permanentFailure) throw new PermanentEmailError('550 mailbox unavailable');
    if (this.failuresBeforeSuccess > 0) {
      this.failuresBeforeSuccess--;
      throw new Error('421 service temporarily unavailable');
    }
    this.sent.push(message);
    this.#waiters.splice(0).forEach((w) => w());
  }

  nextSent(timeoutMs = 10_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timed out waiting for email')), timeoutMs);
      this.#waiters.push(() => {
        clearTimeout(t);
        resolve();
      });
    });
  }
}

class CapturingLogger implements Logger {
  lines: Array<{ level: string; msg: string; fields?: Record<string, unknown> }> = [];
  info(msg: string, fields?: Record<string, unknown>) { this.lines.push({ level: 'info', msg, fields }); }
  warn(msg: string, fields?: Record<string, unknown>) { this.lines.push({ level: 'warn', msg, fields }); }
  error(msg: string, fields?: Record<string, unknown>) { this.lines.push({ level: 'error', msg, fields }); }
}

function setup(opts: { status?: string; pollIntervalMs?: number; maxAttempts?: number; retryBaseDelayMs?: number } = {}) {
  const store = new InMemoryUserStore();
  store.seed({ id: 'u1', email: 'jane.doe@example.com', displayName: 'Jane', status: opts.status ?? 'inactive' });
  const transport = new RecordingTransport();
  const logger = new CapturingLogger();
  const { service, dispatcher } = createAccountStatusNotifications({
    store,
    transport,
    branding,
    logger,
    dispatcher: {
      pollIntervalMs: opts.pollIntervalMs ?? 1000,
      maxAttempts: opts.maxAttempts ?? 3,
      retryBaseDelayMs: opts.retryBaseDelayMs ?? 0,
    },
  });
  return { store, transport, logger, service, dispatcher };
}

describe('[US-026-AC1] Users receive an email notification when their account status changes', () => {
  it('[US-026-AC1][FR-001] sends the "activated" email to the registered address on activation', async () => {
    const { service, dispatcher, transport } = setup({ status: 'inactive' });
    await service.changeStatus(admin, 'u1', 'active');
    await dispatcher.drain();

    assert.equal(transport.sent.length, 1);
    const [msg] = transport.sent;
    assert.equal(msg.to, 'jane.doe@example.com');
    assert.equal(msg.subject, 'User Management: Your account has been activated');
    assert.match(msg.text, /activated on \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/);
    assert.match(msg.text, /can now sign in and access the application/);
    assert.match(msg.html, /<html lang="en">/);
  });

  it('[US-026-AC1][FR-001] sends the "deactivated" email with access and support information', async () => {
    const { service, dispatcher, transport } = setup({ status: 'active' });
    await service.changeStatus(admin, 'u1', 'inactive');
    await dispatcher.drain();

    assert.equal(transport.sent.length, 1);
    const [msg] = transport.sent;
    assert.equal(msg.subject, 'User Management: Your account has been deactivated');
    assert.match(msg.text, /no longer access the application while your account remains inactive/);
    assert.match(msg.text, /support@example\.com/);
    assert.match(msg.html, /support@example\.com/);
  });

  it('[US-026-AC1][FR-001] sends an email on reactivation (inactive -> active after a deactivation)', async () => {
    const { service, dispatcher, transport } = setup({ status: 'active' });
    await service.changeStatus(admin, 'u1', 'inactive');
    await service.changeStatus(admin, 'u1', 'active');
    await dispatcher.drain();

    assert.deepEqual(
      transport.sent.map((m) => m.subject),
      ['User Management: Your account has been deactivated', 'User Management: Your account has been activated'],
    );
  });

  it('[US-026-AC1][FR-001] sends the generic "status changed" email with previous and new status', async () => {
    const { service, dispatcher, transport } = setup({ status: 'active' });
    await service.changeStatus(admin, 'u1', 'suspended');
    await dispatcher.drain();

    const [msg] = transport.sent;
    assert.equal(msg.subject, 'User Management: Your account status has changed');
    assert.match(msg.text, /Previous status: active/);
    assert.match(msg.text, /New status: suspended/);
    assert.match(msg.html, /<th scope="row"[^>]*>Previous status<\/th><td[^>]*>active<\/td>/);
  });

  it('[US-026-AC1] email contains no sensitive data and escapes user-controlled values in HTML', async () => {
    const store = new InMemoryUserStore();
    store.seed({ id: 'u1', email: 'a@example.com', displayName: '<script>x</script>', status: 'inactive' });
    const transport = new RecordingTransport();
    const { service, dispatcher } = createAccountStatusNotifications({ store, transport, branding });
    await service.changeStatus(admin, 'u1', 'active');
    await dispatcher.drain();

    const [msg] = transport.sent;
    assert.doesNotMatch(msg.html, /<script>/);
    assert.match(msg.html, /&lt;script&gt;/);
    for (const body of [msg.html, msg.text]) assert.doesNotMatch(body, /token|otp|password:/i);
  });

  it('[US-026-AC1] the published event carries no email address (PII stays in the user store)', async () => {
    const { service } = setup();
    const result = await service.changeStatus(admin, 'u1', 'active');
    assert.equal(result.changed, true);
    if (result.changed) {
      assert.equal(result.event.topic, 'account-status-change');
      assert.doesNotMatch(JSON.stringify(result.event), /@/);
    }
  });

  it('[US-026-AC1][FR-004] does not send a notification when the same status is submitted again', async () => {
    const { service, dispatcher, transport, store } = setup({ status: 'active' });
    const result = await service.changeStatus(admin, 'u1', 'active');
    await dispatcher.drain();

    assert.deepEqual(result, { changed: false, reason: 'unchanged' });
    assert.equal(transport.sent.length, 0);
    assert.equal(store.entries().length, 0);
  });

  it('[US-026-AC1] rejects unauthorized status changes and sends nothing', async () => {
    const { service, dispatcher, transport, store } = setup();
    await assert.rejects(service.changeStatus({ id: 'x', permissions: [] }, 'u1', 'active'), ForbiddenError);
    await dispatcher.drain();
    assert.equal(transport.sent.length, 0);
    assert.equal((await store.findById('u1'))?.status, 'inactive');
  });

  it('[US-026-AC1] does not notify for failed updates (missing user / concurrent change)', async () => {
    const { service, dispatcher, transport, store } = setup();
    await assert.rejects(service.changeStatus(admin, 'nope', 'active'), NotFoundError);

    const racing = new AccountStatusService({
      users: {
        findById: (id) => store.findById(id),
        updateStatusAndEnqueue: async () => false, // simulates lost optimistic check / failed commit
      },
    });
    await assert.rejects(racing.changeStatus(admin, 'u1', 'active'), ConflictError);
    await dispatcher.drain();
    assert.equal(transport.sent.length, 0);
    assert.equal(store.entries().length, 0);
  });

  it('[US-026-AC1] templates are configurable without changing business logic', async () => {
    const store = new InMemoryUserStore();
    store.seed({ id: 'u1', email: 'a@example.com', status: 'inactive' });
    const transport = new RecordingTransport();
    const templates = {
      ...defaultTemplates,
      'account-activated': { subject: '{{appName}} welcome back', htmlBody: '<p>Hi {{displayName}}</p>', text: 'Hi {{displayName}}' },
    };
    const { service, dispatcher } = createAccountStatusNotifications({ store, transport, branding, templates });
    await service.changeStatus(admin, 'u1', 'active');
    await dispatcher.drain();
    assert.equal(transport.sent[0].subject, 'User Management welcome back');
    assert.match(transport.sent[0].text, /^Hi there/);
  });
});

describe('[US-026-AC2] Notifications are sent promptly following a status change', () => {
  it('[US-026-AC2][FR-002] dispatches immediately after commit, well within 10 seconds, without manual draining', async () => {
    const { service, dispatcher, transport } = setup({ pollIntervalMs: 60_000 }); // poll effectively disabled
    dispatcher.start();
    try {
      const sent = transport.nextSent(10_000);
      const t0 = performance.now();
      await service.changeStatus(admin, 'u1', 'active');
      await sent;
      const elapsed = performance.now() - t0;
      assert.ok(elapsed < 10_000, `dispatch took ${elapsed}ms`);
      assert.equal(transport.sent.length, 1);
    } finally {
      await dispatcher.stop();
    }
  });

  it('[US-026-AC2][FR-002] fallback poll picks up changes committed without a wake-up signal', async () => {
    const store = new InMemoryUserStore();
    store.seed({ id: 'u1', email: 'a@example.com', status: 'inactive' });
    const transport = new RecordingTransport();
    const dispatcher = new AccountStatusNotificationDispatcher({
      outbox: store,
      users: store,
      transport,
      renderer: new TemplateRenderer({ branding }),
      pollIntervalMs: 20,
    });
    const service = new AccountStatusService({ users: store }); // e.g. another process: no kick()
    dispatcher.start();
    try {
      const sent = transport.nextSent(10_000);
      await service.changeStatus(admin, 'u1', 'active');
      await sent;
      assert.equal(transport.sent.length, 1);
    } finally {
      await dispatcher.stop();
    }
  });

  it('[US-026-AC2][FR-003] status update is not blocked by slow email delivery', async () => {
    const { service, dispatcher, transport, store } = setup();
    transport.delayMs = 500;
    dispatcher.start();
    try {
      const t0 = performance.now();
      await service.changeStatus(admin, 'u1', 'active');
      const elapsed = performance.now() - t0;
      assert.ok(elapsed < 100, `changeStatus blocked for ${elapsed}ms`);
      assert.equal((await store.findById('u1'))?.status, 'active');
      assert.equal(transport.sent.length, 0); // still in flight
      await transport.nextSent(5_000);
      assert.equal(transport.sent.length, 1);
    } finally {
      await dispatcher.stop();
    }
  });

  it('[US-026-AC2][FR-003] retries transient delivery failures and then sends exactly once', async () => {
    const { service, dispatcher, transport, store, logger } = setup({ maxAttempts: 3 });
    transport.failuresBeforeSuccess = 2;
    await service.changeStatus(admin, 'u1', 'active');
    await dispatcher.drain();
    await dispatcher.drain();
    await dispatcher.drain();
    await dispatcher.drain(); // extra drain must not re-send

    assert.equal(transport.calls, 3);
    assert.equal(transport.sent.length, 1);
    assert.equal(store.entries()[0].state, 'sent');
    assert.equal(logger.lines.filter((l) => l.level === 'warn').length, 2);
  });

  it('[US-026-AC2][FR-003] uses exponential backoff between retries', async () => {
    let now = 1_000_000;
    const store = new InMemoryUserStore();
    store.seed({ id: 'u1', email: 'a@example.com', status: 'inactive' });
    const transport = new RecordingTransport();
    transport.failuresBeforeSuccess = 2;
    const dispatcher = new AccountStatusNotificationDispatcher({
      outbox: store, users: store, transport, renderer: new TemplateRenderer({ branding }),
      now: () => now, retryBaseDelayMs: 2000, maxAttempts: 5,
    });
    await new AccountStatusService({ users: store, now: () => new Date(now) }).changeStatus(admin, 'u1', 'active');

    await dispatcher.drain();
    assert.equal(store.entries()[0].nextAttemptAt, now + 2000);
    now += 1999;
    await dispatcher.drain();
    assert.equal(transport.calls, 1, 'must not retry before backoff elapses');
    now += 1;
    await dispatcher.drain();
    assert.equal(store.entries()[0].nextAttemptAt, now + 4000);
    now += 4000;
    await dispatcher.drain();
    assert.equal(transport.sent.length, 1);
  });

  it('[US-026-AC2][FR-003] records permanent delivery failure for monitoring and keeps the new status', async () => {
    const { service, dispatcher, transport, store, logger } = setup();
    transport.permanentFailure = true;
    await service.changeStatus(admin, 'u1', 'active');
    await dispatcher.drain();
    await dispatcher.drain();

    assert.equal(transport.calls, 1, 'permanent errors are not retried');
    const [entry] = store.entries();
    assert.equal(entry.state, 'failed');
    assert.match(entry.lastError ?? '', /550/);
    assert.equal((await store.findById('u1'))?.status, 'active');
    const err = logger.lines.find((l) => l.level === 'error');
    assert.ok(err);
    assert.equal(err.fields?.to, 'j***@example.com');
    assert.doesNotMatch(JSON.stringify(logger.lines), /jane\.doe@/);
  });

  it('[US-026-AC2][FR-003] gives up after maxAttempts transient failures', async () => {
    const { service, dispatcher, transport, store } = setup({ maxAttempts: 2 });
    transport.failuresBeforeSuccess = 10;
    await service.changeStatus(admin, 'u1', 'active');
    for (let i = 0; i < 5; i++) await dispatcher.drain();
    assert.equal(transport.calls, 2);
    assert.equal(store.entries()[0].state, 'failed');
    assert.equal(store.entries()[0].attempts, 2);
  });

  it('[US-026-AC2][FR-004] concurrent drains never send the same event twice', async () => {
    const { service, dispatcher, transport } = setup();
    transport.delayMs = 20;
    await service.changeStatus(admin, 'u1', 'active');
    await Promise.all([dispatcher.drain(), dispatcher.drain(), dispatcher.drain()]);
    assert.equal(transport.sent.length, 1);
    assert.ok(transport.sent[0].idempotencyKey);
  });

  it('[US-026-AC2][FR-004] a duplicate event (same eventId) is rejected and not re-sent', async () => {
    const { store, dispatcher, transport } = setup();
    const event: AccountStatusChangedEvent = {
      eventId: 'evt-1', topic: 'account-status-change', schemaVersion: 1,
      userId: 'u1', previousStatus: 'inactive', newStatus: 'active', changedAt: new Date().toISOString(),
    };
    assert.equal(await store.updateStatusAndEnqueue('u1', 'inactive', event), true);
    assert.equal(await store.updateStatusAndEnqueue('u1', 'active', { ...event, newStatus: 'inactive', previousStatus: 'active' }), false);
    await dispatcher.drain();
    assert.equal(transport.sent.length, 1);
  });
});

describe('maskEmail', () => {
  it('masks the local part', () => {
    assert.equal(maskEmail('jane.doe@example.com'), 'j***@example.com');
    assert.equal(maskEmail('invalid'), '***');
  });
});
