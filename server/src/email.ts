import nodemailer from 'nodemailer';
import type { Config } from './config.js';
import type { Repo } from './repo.js';
import type { PlatformSecrets } from './secrets.js';

/** SMTP settings (Admin > Settings > Email), stored encrypted. Amazon SES SMTP, ZeptoMail, Brevo… */
export interface SmtpSettings {
  host: string;
  port: number;
  secure: boolean; // true for 465, false for 587 (STARTTLS)
  user: string;
  pass: string;
  fromName: string;
  fromEmail: string;
  replyTo: string | null;
  enabled: boolean;
}

export interface OutgoingEmail {
  to: string;
  subject: string;
  /** Plain paragraphs; links as [text](url). Rendered into the branded HTML and a text version. */
  body: string[];
  button?: { text: string; url: string };
  kind: string;
  ref?: string | null;
  orgId?: string | null;
}

type Transport = { sendMail: (m: { from: string; to: string; replyTo?: string; subject: string; html: string; text: string }) => Promise<unknown> };

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const linkify = (s: string) => esc(s).replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_m, t, u) => `<a href="${u}" style="color:#b8860b">${t}</a>`);

/**
 * Transactional email over SMTP. Without settings (or when switched off) emails are recorded
 * as "not sent" so every flow works and the log shows what would have gone out.
 */
export class Mailer {
  saved: SmtpSettings | null = null;
  /** Emails "sent" in tests and when SMTP is off (the last 200). */
  readonly outbox: (OutgoingEmail & { text: string; html: string })[] = [];
  /** Replaceable in tests. */
  transportFactory: (s: SmtpSettings) => Transport = (s) =>
    nodemailer.createTransport({ host: s.host, port: s.port, secure: s.secure, auth: { user: s.user, pass: s.pass }, connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000 });
  private transport: Transport | null = null;

  constructor(private readonly config: Config, private readonly repo: Repo, private readonly secrets: PlatformSecrets, private readonly log: { warn: (o: object, m?: string) => void } = console) {}

  async reload(): Promise<void> {
    this.saved = await this.secrets.get<SmtpSettings>('smtp');
    this.transport = null;
  }

  get live(): boolean {
    return Boolean(this.saved?.enabled && this.saved.host && this.saved.fromEmail);
  }

  render(e: OutgoingEmail): { html: string; text: string } {
    const brand = this.config.BRAND_NAME;
    const text = [...e.body.map((p) => p.replace(/\[([^\]]+)\]\((\S+)\)/g, '$1: $2')), ...(e.button ? [`${e.button.text}: ${e.button.url}`] : []), '', `— ${brand}`].join('\n\n');
    const html = `<!doctype html><html><body style="margin:0;background:#f4f5f4;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color:#1b1f22">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:28px 12px">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:12px;border:1px solid #e3e6e4">
<tr><td style="padding:22px 28px 6px;font-weight:800;letter-spacing:.08em;font-size:12px;color:#b8860b;text-transform:uppercase">● ${esc(brand)}</td></tr>
<tr><td style="padding:6px 28px 4px"><h1 style="font-size:20px;margin:0 0 8px">${esc(e.subject)}</h1>
${e.body.map((p) => `<p style="font-size:15px;line-height:1.55;margin:0 0 12px">${linkify(p)}</p>`).join('')}
${e.button ? `<p style="margin:18px 0 8px"><a href="${esc(e.button.url)}" style="display:inline-block;background:#e53935;color:#fff;text-decoration:none;font-weight:700;padding:12px 20px;border-radius:8px">${esc(e.button.text)}</a></p>` : ''}
</td></tr><tr><td style="padding:16px 28px 22px;font-size:12px;color:#7a837f">You get this email because of your ${esc(brand)} account or request.${this.config.SUPPORT_EMAIL ? ` Questions: ${esc(this.config.SUPPORT_EMAIL)}` : ''}</td></tr>
</table></td></tr></table></body></html>`;
    return { html, text };
  }

  /** Sends one email (once per `ref`). Never throws: failures are logged and recorded. */
  async send(e: OutgoingEmail): Promise<boolean> {
    if (!e.to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.to)) return false;
    if (e.ref) {
      const dup = await this.repo.db.query("SELECT 1 FROM emails WHERE ref = $1 AND status = 'sent'", [e.ref]);
      if (dup.rowCount) return true;
    }
    const { html, text } = this.render(e);
    let status: 'sent' | 'failed' | 'not_sent' = 'not_sent';
    let error: string | null = null;
    if (this.live) {
      const s = this.saved!;
      try {
        this.transport ??= this.transportFactory(s);
        await this.transport.sendMail({ from: `"${s.fromName.replace(/"/g, '')}" <${s.fromEmail}>`, to: e.to, replyTo: s.replyTo ?? undefined, subject: e.subject, html, text });
        status = 'sent';
      } catch (err) {
        status = 'failed';
        error = (err as Error).message.slice(0, 500);
        this.transport = null;
        this.log.warn({ err: error, kind: e.kind }, 'email failed');
      }
    } else {
      error = 'Email (SMTP) is not set up';
    }
    this.outbox.push({ ...e, html, text });
    if (this.outbox.length > 200) this.outbox.shift();
    await this.repo.db
      .query('INSERT INTO emails (to_email, subject, kind, status, error, ref, org_id) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING', [
        e.to.toLowerCase(),
        e.subject.slice(0, 300),
        e.kind,
        status,
        error,
        status === 'sent' ? (e.ref ?? null) : null,
        e.orgId ?? null,
      ])
      .catch(() => {});
    return status === 'sent';
  }

  /** Sends to every owner of a club (billing emails go to the billing email too). */
  async toClub(orgId: string, e: Omit<OutgoingEmail, 'to' | 'orgId'>): Promise<void> {
    const rows = (
      await this.repo.db.query<{ email: string }>(
        `SELECT u.email FROM org_members m JOIN users u ON u.id = m.user_id WHERE m.org_id = $1 AND m.role = 'owner' AND NOT u.disabled
         UNION SELECT billing_email FROM org_billing WHERE org_id = $1 AND billing_email IS NOT NULL`,
        [orgId],
      )
    ).rows;
    const seen = new Set<string>();
    for (const r of rows) {
      const to = r.email.toLowerCase();
      if (seen.has(to)) continue;
      seen.add(to);
      await this.send({ ...e, to, orgId, ref: e.ref ? `${e.ref}:${to}` : null });
    }
  }

  /** Sends to the Go Live team: every platform admin and the support address. */
  async toTeam(e: Omit<OutgoingEmail, 'to'>): Promise<void> {
    const rows = (await this.repo.db.query<{ email: string }>('SELECT email FROM users WHERE is_platform_admin AND NOT disabled')).rows.map((r) => r.email.toLowerCase());
    const all = new Set([...rows, ...(this.config.SUPPORT_EMAIL ? [this.config.SUPPORT_EMAIL.toLowerCase()] : [])]);
    for (const to of all) await this.send({ ...e, to, ref: e.ref ? `${e.ref}:${to}` : null });
  }
}
