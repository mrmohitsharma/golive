import type { Config } from './config.js';
import type { Repo } from './repo.js';
import type { Mailer } from './email.js';
import { fromCc } from './billing.js';

/** Credits below which a club gets a "low credits" email (at most once a day). */
export const LOW_BALANCE_CREDITS = 100;

const money = (n: number) => '₹' + n.toLocaleString('en-IN', { maximumFractionDigits: 2 });

/** Billing emails to club owners: receipts, refunds, low credits, suspension. */
export class Notifier {
  constructor(private readonly config: Config, private readonly repo: Repo, private readonly mailer: Mailer) {}

  private get base() {
    return this.config.PUBLIC_BASE_URL.replace(/\/$/, '');
  }

  async receipt(paymentId: string): Promise<void> {
    const p = (
      await this.repo.db.query(
        `SELECT p.*, o.name AS club, (SELECT number FROM invoices i WHERE i.payment_id = p.id AND i.kind = 'invoice') AS invoice
           FROM payments p JOIN orgs o ON o.id = p.org_id WHERE p.id = $1 AND p.status = 'paid'`,
        [paymentId],
      )
    ).rows[0];
    if (!p) return;
    const credits = fromCc(Number(p.credits_cc) + Number(p.bonus_cc ?? 0));
    const balance = fromCc((await this.repo.db.query('SELECT balance_cc FROM org_billing WHERE org_id = $1', [p.org_id])).rows[0]?.balance_cc ?? 0);
    await this.mailer.toClub(p.org_id, {
      kind: 'receipt',
      subject: `Payment received: ${credits.toLocaleString('en-IN')} credits for ${p.club}`,
      body: [
        `We received ${money(Number(p.amount_inr))} for ${p.club}${p.coupon_code ? ` (coupon ${p.coupon_code}, ${money(Number(p.discount_inr))} off)` : ''}. ${credits.toLocaleString('en-IN')} credits are in your wallet; the balance is now ${balance.toLocaleString('en-IN')} credits.`,
        `Order ${p.order_id}${p.invoice ? `. Your GST invoice ${p.invoice} is in the Wallet page.` : '.'}`,
      ],
      button: { text: 'Open your wallet', url: `${this.base}/web/wallet` },
      ref: `receipt:${p.id}`,
    });
  }

  async refund(refundId: string): Promise<void> {
    const r = (await this.repo.db.query('SELECT r.*, p.order_id, o.name AS club FROM refunds r JOIN payments p ON p.id = r.payment_id JOIN orgs o ON o.id = r.org_id WHERE r.id = $1', [refundId])).rows[0];
    if (!r || r.status !== 'success') return;
    await this.mailer.toClub(r.org_id, {
      kind: 'refund',
      subject: `Refund of ${money(Number(r.amount_inr))} done`,
      body: [
        `We refunded ${money(Number(r.amount_inr))} for order ${r.order_id} (${r.club}) to the account you paid from. Banks usually show it within 5–7 working days.`,
        Number(r.credits_cc) > 0 ? `${fromCc(r.credits_cc).toLocaleString('en-IN')} credits were taken back from your wallet.` : '',
        r.note ? `Reason: ${r.note}` : '',
      ].filter(Boolean),
      button: { text: 'Open your wallet', url: `${this.base}/web/wallet` },
      ref: `refund:${r.id}`,
    });
  }

  /** Called whenever a wallet changes. Emails once when credits drop below the line, again only after a top-up. */
  async walletChanged(orgId: string): Promise<void> {
    const b = (await this.repo.db.query('SELECT balance_cc, low_balance_emailed_at FROM org_billing WHERE org_id = $1', [orgId])).rows[0];
    if (!b) return;
    const credits = fromCc(b.balance_cc);
    if (credits >= LOW_BALANCE_CREDITS) {
      if (b.low_balance_emailed_at) await this.repo.db.query('UPDATE org_billing SET low_balance_emailed_at = NULL WHERE org_id = $1', [orgId]);
      return;
    }
    if (b.low_balance_emailed_at && Date.now() - new Date(b.low_balance_emailed_at).getTime() < 24 * 3600_000) return;
    // Only clubs that have used or bought credits (not brand-new sign-ups at 0).
    const used = (await this.repo.db.query("SELECT 1 FROM wallet_tx WHERE org_id = $1 AND kind IN ('purchase', 'admin') LIMIT 1", [orgId])).rowCount;
    if (!used) return;
    const claimed = await this.repo.db.query(
      "UPDATE org_billing SET low_balance_emailed_at = now() WHERE org_id = $1 AND (low_balance_emailed_at IS NULL OR low_balance_emailed_at < now() - interval '24 hours') RETURNING org_id",
      [orgId],
    );
    if (!claimed.rowCount) return;
    const club = (await this.repo.orgById(orgId))?.name ?? 'your club';
    await this.mailer.toClub(orgId, {
      kind: 'low_balance',
      subject: `${club} is low on credits`,
      body: [`${club} has ${credits.toLocaleString('en-IN')} credits left. When credits run out during a broadcast, it ends after a short grace period.`, 'Top up now so your next event is not interrupted.'],
      button: { text: 'Buy credits', url: `${this.base}/web/wallet` },
    });
  }

  async suspended(orgId: string, reason: string | null): Promise<void> {
    const club = (await this.repo.orgById(orgId))?.name ?? 'Your club';
    await this.mailer.toClub(orgId, {
      kind: 'suspended',
      subject: `${club} has been suspended`,
      body: [`${club} cannot go live for now.${reason ? ` Reason: ${reason}` : ''}`, `Reply to this email or contact ${this.config.SUPPORT_EMAIL ?? 'support'} to sort it out.`],
      button: { text: 'Contact support', url: `${this.base}/web/help` },
    });
  }
}
