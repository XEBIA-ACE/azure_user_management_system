/**
 * US-026 — Account status email templates (DRAFT — pending review/approval,
 * see DOD-1 / DOR-2 in specs/US-026/spec.md).
 *
 * Template content lives in `defaultTemplates` as plain data and can be
 * replaced wholesale via `TemplateRenderer` options, so wording/branding can
 * change without touching notification business logic.
 *
 * Placeholders use `{{name}}`. In HTML bodies every value is HTML-escaped.
 * Available variables: appName, displayName, previousStatus, newStatus,
 * effectiveAt, supportContact. Templates must never reference passwords,
 * tokens or other secrets — none are ever passed to the renderer.
 */

import { AccountStatus, type AccountStatusChangedEvent, type UserRecord } from './contracts.ts';

export type TemplateId = 'account-activated' | 'account-deactivated' | 'account-status-changed';

export interface TemplateDefinition {
  subject: string;
  /** Inner HTML content; wrapped in the shared responsive/accessible layout. */
  htmlBody: string;
  text: string;
}

export type TemplateSet = Record<TemplateId, TemplateDefinition>;

export interface Branding {
  appName: string;
  /** Optional support contact / recovery instructions shown on deactivation. */
  supportContact?: string;
}

export const defaultTemplates: TemplateSet = {
  'account-activated': {
    subject: '{{appName}}: Your account has been activated',
    htmlBody: `
<h1 style="font-size:22px;margin:0 0 16px;">Your account has been activated</h1>
<p>Hello {{displayName}},</p>
<p>Your {{appName}} account was activated on <strong>{{effectiveAt}}</strong>.</p>
<p>You can now sign in and access the application.</p>`,
    text: `Your account has been activated

Hello {{displayName}},

Your {{appName}} account was activated on {{effectiveAt}}.
You can now sign in and access the application.`,
  },
  'account-deactivated': {
    subject: '{{appName}}: Your account has been deactivated',
    htmlBody: `
<h1 style="font-size:22px;margin:0 0 16px;">Your account has been deactivated</h1>
<p>Hello {{displayName}},</p>
<p>Your {{appName}} account was deactivated on <strong>{{effectiveAt}}</strong>.</p>
<p>You can no longer access the application while your account remains inactive.</p>
{{#supportContact}}<p>If you believe this is a mistake or want to restore access, contact {{supportContact}}.</p>{{/supportContact}}`,
    text: `Your account has been deactivated

Hello {{displayName}},

Your {{appName}} account was deactivated on {{effectiveAt}}.
You can no longer access the application while your account remains inactive.
{{#supportContact}}
If you believe this is a mistake or want to restore access, contact {{supportContact}}.{{/supportContact}}`,
  },
  'account-status-changed': {
    subject: '{{appName}}: Your account status has changed',
    htmlBody: `
<h1 style="font-size:22px;margin:0 0 16px;">Your account status has changed</h1>
<p>Hello {{displayName}},</p>
<p>The status of your {{appName}} account changed on <strong>{{effectiveAt}}</strong>.</p>
<table role="presentation" style="border-collapse:collapse;margin:8px 0 16px;">
  <tr><th scope="row" style="text-align:left;padding:4px 12px 4px 0;">Previous status</th><td style="padding:4px 0;">{{previousStatus}}</td></tr>
  <tr><th scope="row" style="text-align:left;padding:4px 12px 4px 0;">New status</th><td style="padding:4px 0;">{{newStatus}}</td></tr>
</table>`,
    text: `Your account status has changed

Hello {{displayName}},

The status of your {{appName}} account changed on {{effectiveAt}}.
Previous status: {{previousStatus}}
New status: {{newStatus}}`,
  },
};

/** Shared responsive, screen-reader-friendly HTML layout. */
const layout = (appName: string, subject: string, body: string, footer: string) => `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${subject}</title>
</head>
<body style="margin:0;padding:0;background:#f4f5f7;font-family:Arial,Helvetica,sans-serif;color:#1f2933;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:6px;">
<tr><td style="padding:20px 24px;border-bottom:1px solid #e4e7eb;font-size:18px;font-weight:bold;">${appName}</td></tr>
<tr><td style="padding:24px;font-size:16px;line-height:1.5;">${body}</td></tr>
<tr><td style="padding:16px 24px;border-top:1px solid #e4e7eb;font-size:12px;color:#52606d;">${footer}</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;

const FOOTER_TEXT =
  'This is an automated security notification about your account. We will never ask for your password by email.';

export interface RenderedEmail {
  templateId: TemplateId;
  subject: string;
  html: string;
  text: string;
}

export function selectTemplate(event: AccountStatusChangedEvent): TemplateId {
  if (event.newStatus === AccountStatus.ACTIVE) return 'account-activated';
  if (event.newStatus === AccountStatus.INACTIVE) return 'account-deactivated';
  return 'account-status-changed';
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function interpolate(template: string, vars: Record<string, string>, escape: (s: string) => string): string {
  // Optional sections: {{#name}}...{{/name}} rendered only when `name` is non-empty.
  const withSections = template.replace(/\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_m, name: string, inner: string) =>
    vars[name] ? inner : '',
  );
  return withSections.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => escape(vars[name] ?? ''));
}

export interface TemplateRendererOptions {
  branding: Branding;
  templates?: TemplateSet;
  /** Formats the effective timestamp; defaults to an unambiguous UTC string. */
  formatDate?: (iso: string) => string;
}

const defaultFormatDate = (iso: string) => {
  const d = new Date(iso);
  return `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
};

export class TemplateRenderer {
  readonly #branding: Branding;
  readonly #templates: TemplateSet;
  readonly #formatDate: (iso: string) => string;

  constructor(options: TemplateRendererOptions) {
    this.#branding = options.branding;
    this.#templates = options.templates ?? defaultTemplates;
    this.#formatDate = options.formatDate ?? defaultFormatDate;
  }

  render(event: AccountStatusChangedEvent, user: Pick<UserRecord, 'displayName'>): RenderedEmail {
    const templateId = selectTemplate(event);
    const def = this.#templates[templateId];
    const vars: Record<string, string> = {
      appName: this.#branding.appName,
      displayName: user.displayName?.trim() || 'there',
      previousStatus: event.previousStatus,
      newStatus: event.newStatus,
      effectiveAt: this.#formatDate(event.changedAt),
      supportContact: this.#branding.supportContact ?? '',
    };
    const identity = (s: string) => s;
    const subject = interpolate(def.subject, vars, identity);
    const body = interpolate(def.htmlBody, vars, escapeHtml);
    return {
      templateId,
      subject,
      html: layout(escapeHtml(this.#branding.appName), escapeHtml(subject), body, FOOTER_TEXT),
      text: `${interpolate(def.text, vars, identity)}\n\n--\n${this.#branding.appName}\n${FOOTER_TEXT}\n`,
    };
  }
}
