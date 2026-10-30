import type { Config } from './config.js';
import type { Repo } from './repo.js';
import { HttpError } from './errors.js';

export type MessageKind = 'reminder' | 'otp' | 'winner' | 'draw_entry';

/** MSG91 settings: from Admin > SMS (stored encrypted) or, if not set there, the server config. */
export interface Msg91Settings {
  authKey: string;
  templates: Record<MessageKind, string | null>;
}

/** One message: the template's variables in order ({#var#} 1, 2, 3 in the DLT template). */
export interface OutgoingMessage {
  kind: MessageKind;
  phone: string;
  vars: string[];
  tournamentId?: string | null;
}

/**
 * Indian mobile number → "91XXXXXXXXXX". Accepts +91, 0-prefixed and spaced forms.
 * Other countries: full international number (8–15 digits) with its country code.
 */
export function normalisePhone(input: string): string {
  const digits = input.replace(/[^\d+]/g, '');
  let d = digits.startsWith('+') ? digits.slice(1) : digits;
  if (/^0\d{10}$/.test(d)) d = d.slice(1);
  if (/^[6-9]\d{9}$/.test(d)) d = `91${d}`;
  if (!/^\d{8,15}$/.test(d)) throw new HttpError(400, 'bad_phone', 'Enter a valid mobile number, like 98123 45678.');
  if (d.startsWith('91') && !/^91[6-9]\d{9}$/.test(d)) throw new HttpError(400, 'bad_phone', 'Enter a valid 10-digit Indian mobile number.');
  return d;
}

export const maskPhone = (p: string) => (p.length > 6 ? `${p.slice(0, 2)}${'*'.repeat(p.length - 6)}${p.slice(-4)}` : '****');

/**
 * SMS through MSG91's Flow API (DLT-approved templates; WhatsApp can be added the same way).
 * Without MSG91_AUTH_KEY, a test sender records messages in the outbox and the log only, so
 * every feature works before DLT approval. Every message is recorded in `messages`.
 */
export class Messenger {
  /** Test sender: the last messages, so tests (and the admin) can see what would have gone out. */
  readonly sentInTest: (OutgoingMessage & { text: string })[] = [];

  /** Billing: how many of n new messages of an event may go out (the rest are recorded as not sent). */
  gate?: (tournamentId: string, n: number, alreadySent: number, critical: boolean) => Promise<number>;

  constructor(
    private readonly config: Config,
    private readonly repo: Repo,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly log: { info: (o: object, m?: string) => void; warn: (o: object, m?: string) => void } = console,
  ) {}

  /** Settings saved in the admin panel (null = use the server config). */
  saved: Msg91Settings | null = null;

  get settings(): Msg91Settings | null {
    if (this.saved?.authKey) return this.saved;
    if (!this.config.MSG91_AUTH_KEY) return null;
    return {
      authKey: this.config.MSG91_AUTH_KEY,
      templates: {
        otp: this.config.MSG91_TEMPLATE_OTP ?? null,
        reminder: this.config.MSG91_TEMPLATE_REMINDER ?? null,
        winner: this.config.MSG91_TEMPLATE_WINNER ?? null,
        draw_entry: this.config.MSG91_TEMPLATE_DRAW ?? null,
      },
    };
  }

  get source(): 'admin' | 'server config' | 'none' {
    return this.saved?.authKey ? 'admin' : this.config.MSG91_AUTH_KEY ? 'server config' : 'none';
  }

  get live(): boolean {
    return Boolean(this.settings?.authKey);
  }

  private template(kind: MessageKind): string | undefined {
    return this.settings?.templates[kind] ?? undefined;
  }

  /** The text as approved in DLT (used for the test sender and the outbox preview). */
  static text(kind: MessageKind, v: string[]): string {
    switch (kind) {
      case 'otp':
        return `${v[0]} is your Go Live code to claim your prize. Valid for 10 minutes. Do not share it.`;
      case 'reminder':
        return `${v[0]} is live now on Go Live. Watch: ${v[1]}`;
      case 'winner':
        return `You won ${v[0]} in ${v[1]}! Claim within 24 hours: ${v[2]} - Go Live`;
      case 'draw_entry':
        return `You are in the ${v[0]} lucky draw. Winners announced at the end of the show - Go Live`;
    }
  }

  /** Sends several messages of one kind (MSG91 takes up to 1,000 recipients per call). Returns how many went out. */
  async send(input: OutgoingMessage[]): Promise<number> {
    let sent = 0;
    let list = input;
    // Included messages first, then paid ones; over the limit they are not sent (codes always are).
    const tid = list[0]?.tournamentId;
    if (tid && this.gate && list.length) {
      const allowed = await this.gate(tid, list.length, await this.countForEvent(tid), list[0].kind === 'otp');
      if (allowed < list.length) {
        const skipped = list.slice(allowed);
        list = list.slice(0, allowed);
        const vals: unknown[] = [];
        const rows = skipped.map((m, j) => {
          vals.push(tid, m.kind, maskPhone(m.phone));
          return `($${j * 3 + 1}::uuid, $${j * 3 + 2}, $${j * 3 + 3}, 'none', 'failed', 'no_credits')`;
        });
        await this.repo.db.query(`INSERT INTO messages (tournament_id, kind, to_masked, provider, status, error) VALUES ${rows.join(', ')}`, vals);
        this.log.warn({ tournamentId: tid, skipped: skipped.length }, 'messages not sent: no credits left');
      }
      if (!list.length) return 0;
    }
    for (let i = 0; i < list.length; i += 500) {
      const part = list.slice(i, i + 500);
      const kind = part[0].kind;
      let ok = true;
      let error: string | null = null;
      if (this.live) {
        const template = this.template(kind);
        if (!template) {
          ok = false;
          error = `MSG91 template for ${kind} is not set`;
        } else {
          try {
            const res = await this.fetchImpl(`${this.config.MSG91_API_BASE}/flow`, {
              method: 'POST',
              headers: { authkey: this.settings!.authKey, 'content-type': 'application/json', accept: 'application/json' },
              body: JSON.stringify({
                template_id: template,
                short_url: '0',
                recipients: part.map((m) => ({ mobiles: m.phone, ...Object.fromEntries(m.vars.map((v, j) => [`var${j + 1}`, v])) })),
              }),
            });
            const body = (await res.json().catch(() => ({}))) as { type?: string; message?: string };
            if (!res.ok || body.type === 'error') {
              ok = false;
              error = body.message ?? `HTTP ${res.status}`;
            }
          } catch (err) {
            ok = false;
            error = (err as Error).message;
          }
        }
      } else {
        for (const m of part) {
          const text = Messenger.text(m.kind, m.vars);
          this.sentInTest.push({ ...m, text });
          if (this.sentInTest.length > 200) this.sentInTest.shift();
          this.log.info({ to: maskPhone(m.phone), kind: m.kind, text }, 'test sender (MSG91 not configured)');
        }
      }
      if (!ok) this.log.warn({ kind, error }, 'message send failed');
      const vals: unknown[] = [];
      const rows = part.map((m, j) => {
        vals.push(m.tournamentId ?? null, m.kind, maskPhone(m.phone), this.live ? 'msg91' : 'test', ok ? 'sent' : 'failed', error);
        const b = j * 6;
        return `($${b + 1}::uuid, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6})`;
      });
      await this.repo.db.query(`INSERT INTO messages (tournament_id, kind, to_masked, provider, status, error) VALUES ${rows.join(', ')}`, vals);
      if (ok) sent += part.length;
    }
    return sent;
  }

  async countForEvent(tournamentId: string): Promise<number> {
    return Number(
      (await this.repo.db.query<{ n: string }>("SELECT count(*)::text AS n FROM messages WHERE tournament_id = $1 AND status = 'sent'", [tournamentId])).rows[0].n,
    );
  }
}
