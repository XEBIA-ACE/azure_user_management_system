export * from './contracts.ts';
export * from './templates.ts';
export * from './account-status-service.ts';
export * from './notification-dispatcher.ts';
export * from './in-memory-store.ts';

import { AccountStatusService } from './account-status-service.ts';
import type { EmailTransport, Logger, OutboxStore, UserRepository } from './contracts.ts';
import { AccountStatusNotificationDispatcher, type DispatcherOptions } from './notification-dispatcher.ts';
import { type Branding, TemplateRenderer, type TemplateSet } from './templates.ts';

export interface AccountStatusNotificationsConfig {
  store: UserRepository & OutboxStore;
  transport: EmailTransport;
  branding: Branding;
  templates?: TemplateSet;
  logger?: Logger;
  dispatcher?: Omit<DispatcherOptions, 'outbox' | 'users' | 'transport' | 'renderer' | 'logger'>;
}

/** Wires the service and dispatcher so a committed change wakes the dispatcher immediately. */
export function createAccountStatusNotifications(config: AccountStatusNotificationsConfig) {
  const dispatcher = new AccountStatusNotificationDispatcher({
    ...config.dispatcher,
    outbox: config.store,
    users: config.store,
    transport: config.transport,
    renderer: new TemplateRenderer({ branding: config.branding, templates: config.templates }),
    logger: config.logger,
  });
  const service = new AccountStatusService({
    users: config.store,
    logger: config.logger,
    onCommitted: () => dispatcher.kick(),
  });
  return { service, dispatcher };
}
