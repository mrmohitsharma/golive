import type pg from 'pg';
import type { Repo } from './repo.js';
import { HttpError } from './errors.js';

/** Seller details on invoices (Admin > Money > Invoices). */
export interface InvoiceSettings {
  enabled: boolean;
  legalName: string;
  address: string;
  gstin: string | null;
  pan: string | null;
  stateCode: string;         // 2 digits, e.g. "06" Haryana
  sac: string;               // service accounting code
  gstRate: number;           // %, e.g. 18
  pricesIncludeGst: boolean; // pack prices already include GST
  prefix: string;            // e.g. "GL"
  email: string | null;
}

export const DEFAULT_INVOICE_SETTINGS: InvoiceSettings = {
  enabled: false,
  legalName: '',
  address: '',
  gstin: null,
  pan: null,
  stateCode: '06',
  sac: '998439',
  gstRate: 18,
  pricesIncludeGst: true,
  prefix: 'GL',
  email: null,
};

export interface InvoiceRow {
  id: string;
  kind: 'invoice' | 'credit_note';
  number: string;
  org_id: string;
  payment_id: string | null;
  refund_id: string | null;
  issued_at: Date;
  seller: InvoiceSettings;
  buyer: { name: string; gstin: string | null; email: string | null; phone: string | null; stateCode: string | null };
  description: string;
  taxable_inr: string;
  cgst_inr: string;
  sgst_inr: string;
  igst_inr: string;
  total_inr: string;
  org_name?: string;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Indian financial year label for a date: April to March, e.g. "2026-27". */
export function financialYear(d: Date): string {
  const ist = new Date(d.getTime() + 5.5 * 3600_000);
  const y = ist.getUTCFullYear();
  const start = ist.getUTCMonth() >= 3 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

/** Splits a total into taxable value and GST: CGST+SGST within the seller's state, IGST across states. */
export function gstSplit(total: number, s: InvoiceSettings, buyerState: string | null) {
  const rate = s.gstRate / 100;
  const taxable = s.pricesIncludeGst ? r2(total / (1 + rate)) : r2(total);
  const gross = s.pricesIncludeGst ? r2(total) : r2(total * (1 + rate));
  const tax = r2(gross - taxable);
  const intra = !buyerState || buyerState === s.stateCode;
  if (intra) {
    const half = r2(tax / 2);
    return { taxable, cgst: half, sgst: r2(tax - half), igst: 0, total: gross };
  }
  return { taxable, cgst: 0, sgst: 0, igst: tax, total: gross };
}

/**
 * GST tax invoices for credit purchases and credit notes for refunds. Numbers run per
 * financial year without gaps: GL/2026-27/000001 and GL/CN/2026-27/000001.
 */
export class InvoiceService {
  constructor(private readonly repo: Repo) {}

  async settings(): Promise<InvoiceSettings> {
    const r = (await this.repo.db.query<{ invoice: Partial<InvoiceSettings> }>('SELECT invoice FROM platform_settings WHERE id')).rows[0];
    return { ...DEFAULT_INVOICE_SETTINGS, ...(r?.invoice ?? {}) };
  }

  async saveSettings(v: InvoiceSettings): Promise<void> {
    await this.repo.db.query('UPDATE platform_settings SET invoice = $1 WHERE id', [JSON.stringify(v)]);
  }

  private async nextNumber(c: pg.PoolClient, s: InvoiceSettings, kind: 'invoice' | 'credit_note', at: Date): Promise<string> {
    const series = `${s.prefix}${kind === 'credit_note' ? '/CN' : ''}/${financialYear(at)}`;
    const r = await c.query<{ last: number }>(
      `INSERT INTO invoice_counters (series, last) VALUES ($1, 1) ON CONFLICT (series) DO UPDATE SET last = invoice_counters.last + 1 RETURNING last`,
      [series],
    );
    return `${series}/${String(r.rows[0].last).padStart(6, '0')}`;
  }

  private async buyer(c: pg.PoolClient, orgId: string) {
    const r = (
      await c.query<{ name: string; billing_name: string | null; gstin: string | null; billing_email: string | null; billing_phone: string | null }>(
        'SELECT o.name, b.billing_name, b.gstin, b.billing_email, b.billing_phone FROM orgs o LEFT JOIN org_billing b ON b.org_id = o.id WHERE o.id = $1',
        [orgId],
      )
    ).rows[0];
    return {
      name: r?.billing_name || r?.name || 'Customer',
      gstin: r?.gstin ?? null,
      email: r?.billing_email ?? null,
      phone: r?.billing_phone ?? null,
      stateCode: r?.gstin ? r.gstin.slice(0, 2) : null,
    };
  }

  /** The invoice for a paid payment (created once; later calls return the same one). */
  async forPayment(paymentId: string, c?: pg.PoolClient): Promise<InvoiceRow | null> {
    const run = async (q: pg.PoolClient) => {
      const existing = (await q.query<InvoiceRow>("SELECT * FROM invoices WHERE payment_id = $1 AND kind = 'invoice'", [paymentId])).rows[0];
      if (existing) return existing;
      const s = await this.settings();
      if (!s.enabled) return null;
      const p = (await q.query('SELECT * FROM payments WHERE id = $1 AND status = $2', [paymentId, 'paid'])).rows[0];
      if (!p) return null;
      const buyer = await this.buyer(q, p.org_id);
      const g = gstSplit(Number(p.amount_inr), s, buyer.stateCode);
      const at = p.paid_at ?? new Date();
      const number = await this.nextNumber(q, s, 'invoice', at);
      const credits = Number(p.credits_cc) / 100;
      const desc = `Go Live streaming credits: ${credits.toLocaleString('en-IN')} credits${Number(p.bonus_cc) ? ` + ${(Number(p.bonus_cc) / 100).toLocaleString('en-IN')} bonus` : ''}${p.coupon_code ? ` (coupon ${p.coupon_code}, ₹${Number(p.discount_inr)} off)` : ''}. Order ${p.order_id}.`;
      return (
        await q.query<InvoiceRow>(
          `INSERT INTO invoices (kind, number, org_id, payment_id, issued_at, seller, buyer, description, taxable_inr, cgst_inr, sgst_inr, igst_inr, total_inr)
           VALUES ('invoice', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
          [number, p.org_id, p.id, at, JSON.stringify(s), JSON.stringify(buyer), desc, g.taxable, g.cgst, g.sgst, g.igst, g.total],
        )
      ).rows[0];
    };
    return c ? run(c) : this.repo.tx(run);
  }

  /** A credit note for a successful refund, against the payment's invoice. */
  async forRefund(refundId: string, c?: pg.PoolClient): Promise<InvoiceRow | null> {
    const run = async (q: pg.PoolClient) => {
      const existing = (await q.query<InvoiceRow>("SELECT * FROM invoices WHERE refund_id = $1 AND kind = 'credit_note'", [refundId])).rows[0];
      if (existing) return existing;
      const r = (await q.query('SELECT * FROM refunds WHERE id = $1 AND status = $2', [refundId, 'success'])).rows[0];
      if (!r) return null;
      const inv = (await q.query<InvoiceRow>("SELECT * FROM invoices WHERE payment_id = $1 AND kind = 'invoice'", [r.payment_id])).rows[0];
      if (!inv) return null; // no invoice was issued (invoices were off), so no credit note either
      const s = inv.seller;
      const g = gstSplit(Number(r.amount_inr), { ...s, pricesIncludeGst: true }, inv.buyer.stateCode);
      const number = await this.nextNumber(q, await this.settings(), 'credit_note', new Date());
      return (
        await q.query<InvoiceRow>(
          `INSERT INTO invoices (kind, number, org_id, payment_id, refund_id, seller, buyer, description, taxable_inr, cgst_inr, sgst_inr, igst_inr, total_inr)
           VALUES ('credit_note', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
          [number, r.org_id, r.payment_id, r.id, JSON.stringify(s), JSON.stringify(inv.buyer), `Refund against invoice ${inv.number}${r.note ? `: ${r.note}` : ''}.`, g.taxable, g.cgst, g.sgst, g.igst, g.total],
        )
      ).rows[0];
    };
    return c ? run(c) : this.repo.tx(run);
  }

  async byId(id: string): Promise<InvoiceRow | null> {
    return (await this.repo.db.query<InvoiceRow>('SELECT i.*, o.name AS org_name FROM invoices i JOIN orgs o ON o.id = i.org_id WHERE i.id = $1', [id])).rows[0] ?? null;
  }

  async list(f: { orgId?: string; from?: string; to?: string; limit?: number }): Promise<InvoiceRow[]> {
    const w: string[] = [];
    const v: unknown[] = [];
    if (f.orgId) (v.push(f.orgId), w.push(`i.org_id = $${v.length}`));
    if (f.from) (v.push(f.from), w.push(`i.issued_at >= $${v.length}::date`));
    if (f.to) (v.push(f.to), w.push(`i.issued_at < $${v.length}::date + 1`));
    v.push(f.limit ?? 500);
    return (
      await this.repo.db.query<InvoiceRow>(
        `SELECT i.*, o.name AS org_name FROM invoices i JOIN orgs o ON o.id = i.org_id ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY i.issued_at DESC, i.number DESC LIMIT $${v.length}`,
        v,
      )
    ).rows;
  }

  /** Issues invoices for paid payments that have none yet (after invoices are switched on). */
  async backfill(): Promise<number> {
    if (!(await this.settings()).enabled) throw new HttpError(409, 'invoices_off', 'Fill in your invoice details and switch invoices on first.');
    const ids = (await this.repo.db.query<{ id: string }>(
      "SELECT p.id FROM payments p WHERE p.status = 'paid' AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.payment_id = p.id AND i.kind = 'invoice') ORDER BY p.paid_at",
    )).rows;
    let n = 0;
    for (const { id } of ids) if (await this.forPayment(id)) n++;
    return n;
  }
}

export function invoiceDto(i: InvoiceRow) {
  return {
    id: i.id,
    kind: i.kind,
    number: i.number,
    orgId: i.org_id,
    orgName: i.org_name ?? null,
    paymentId: i.payment_id,
    refundId: i.refund_id,
    issuedAt: new Date(i.issued_at).toISOString(),
    buyer: i.buyer,
    description: i.description,
    taxableInr: Number(i.taxable_inr),
    cgstInr: Number(i.cgst_inr),
    sgstInr: Number(i.sgst_inr),
    igstInr: Number(i.igst_inr),
    totalInr: Number(i.total_inr),
  };
}

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const money = (n: unknown) => '₹' + Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** A printable invoice page (Print → Save as PDF). */
export function invoiceHtml(i: InvoiceRow): string {
  const s = i.seller;
  const b = i.buyer;
  const title = i.kind === 'credit_note' ? 'Credit note' : 'Tax invoice';
  const rows = [
    ['Taxable value', i.taxable_inr],
    ...(Number(i.cgst_inr) ? [[`CGST ${s.gstRate / 2}%`, i.cgst_inr], [`SGST ${s.gstRate / 2}%`, i.sgst_inr]] : []),
    ...(Number(i.igst_inr) ? [[`IGST ${s.gstRate}%`, i.igst_inr]] : []),
  ];
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)} ${esc(i.number)}</title>
<style>body{font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#111;max-width:760px;margin:32px auto;padding:0 20px}
h1{font-size:22px;margin:0}.top{display:flex;justify-content:space-between;gap:24px;border-bottom:2px solid #111;padding-bottom:14px;margin-bottom:18px}
.muted{color:#555}table{width:100%;border-collapse:collapse;margin-top:16px}td,th{border-bottom:1px solid #ddd;padding:8px;text-align:left}td.n,th.n{text-align:right}
.tot td{font-weight:700;border-top:2px solid #111}.grid{display:grid;grid-template-columns:1fr 1fr;gap:24px}@media print{.noprint{display:none}}</style></head><body>
<div class="noprint" style="text-align:right;margin-bottom:12px"><button onclick="print()">Print / Save as PDF</button></div>
<div class="top"><div><h1>${esc(title)}</h1><div class="muted">No. ${esc(i.number)}<br>Date ${esc(new Date(i.issued_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' }))}</div></div>
<div style="text-align:right"><strong>${esc(s.legalName)}</strong><br>${esc(s.address).replace(/\n/g, '<br>')}${s.gstin ? `<br>GSTIN ${esc(s.gstin)}` : ''}${s.pan ? `<br>PAN ${esc(s.pan)}` : ''}${s.email ? `<br>${esc(s.email)}` : ''}</div></div>
<div class="grid"><div><div class="muted">Billed to</div><strong>${esc(b.name)}</strong>${b.gstin ? `<br>GSTIN ${esc(b.gstin)}` : ''}${b.email ? `<br>${esc(b.email)}` : ''}${b.phone ? `<br>${esc(b.phone)}` : ''}</div>
<div><div class="muted">Place of supply</div>State code ${esc(b.stateCode ?? s.stateCode)}<br><span class="muted">SAC ${esc(s.sac)}</span></div></div>
<table><thead><tr><th>Description</th><th class="n">Amount</th></tr></thead><tbody>
<tr><td>${esc(i.description)}</td><td class="n">${money(i.taxable_inr)}</td></tr>
${rows.slice(1).map(([k, v]) => `<tr><td class="muted">${esc(k)}</td><td class="n">${money(v)}</td></tr>`).join('')}
<tr class="tot"><td>Total${i.kind === 'credit_note' ? ' refunded' : ''}</td><td class="n">${money(i.total_inr)}</td></tr></tbody></table>
<p class="muted" style="margin-top:24px">This is a computer-generated ${esc(title.toLowerCase())} and needs no signature.</p></body></html>`;
}
