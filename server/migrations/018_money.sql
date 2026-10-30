-- V7 money: gateway keys set from the admin panel, refunds, coupons, GST invoices and a log
-- of every message the payment gateway sends us.

-- Secrets set in the admin panel (encrypted with DATA_KEY), e.g. 'cashfree', 'msg91'.
CREATE TABLE platform_secrets (
  key        text PRIMARY KEY,
  value_enc  text NOT NULL,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Seller details printed on GST invoices.
ALTER TABLE platform_settings ADD COLUMN invoice jsonb NOT NULL DEFAULT '{}';

-- Coupons: a % off the pack price, or bonus credits on top.
CREATE TABLE coupons (
  code          text PRIMARY KEY,                    -- upper case, e.g. LAUNCH20
  kind          text NOT NULL CHECK (kind IN ('percent_off', 'bonus_credits')),
  value         numeric(12,2) NOT NULL CHECK (value > 0),
  description   text,
  max_uses      integer,                             -- null = unlimited
  once_per_club boolean NOT NULL DEFAULT true,
  min_inr       numeric(12,2),                       -- smallest pack it works on
  valid_from    timestamptz,
  valid_to      timestamptz,
  active        boolean NOT NULL DEFAULT true,
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE coupon_redemptions (
  id         bigserial PRIMARY KEY,
  code       text NOT NULL REFERENCES coupons(code) ON DELETE CASCADE,
  org_id     uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  payment_id uuid NOT NULL UNIQUE REFERENCES payments(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX coupon_redemptions_code ON coupon_redemptions (code, org_id);

ALTER TABLE payments ADD COLUMN list_inr     numeric(12,2);          -- pack price before the coupon
ALTER TABLE payments ADD COLUMN coupon_code  text;
ALTER TABLE payments ADD COLUMN discount_inr numeric(12,2) NOT NULL DEFAULT 0;
ALTER TABLE payments ADD COLUMN bonus_cc     bigint NOT NULL DEFAULT 0;

-- Refunds through the gateway. Credits are taken back when the refund is made, and given
-- back if the gateway reports it failed.
CREATE TABLE refunds (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id   uuid NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  org_id       uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  refund_id    text NOT NULL UNIQUE,                 -- ours, sent to the gateway
  amount_inr   numeric(12,2) NOT NULL CHECK (amount_inr > 0),
  credits_cc   bigint NOT NULL DEFAULT 0,            -- credits taken from the wallet
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'success', 'failed', 'cancelled')),
  note         text,
  provider_ref text,
  error        text,
  created_by   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);
CREATE INDEX refunds_payment ON refunds (payment_id);

-- Tax invoices (one per paid payment) and credit notes (one per successful refund).
CREATE TABLE invoices (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind        text NOT NULL CHECK (kind IN ('invoice', 'credit_note')),
  number      text NOT NULL UNIQUE,
  org_id      uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  payment_id  uuid REFERENCES payments(id) ON DELETE SET NULL,
  refund_id   uuid REFERENCES refunds(id) ON DELETE SET NULL,
  issued_at   timestamptz NOT NULL DEFAULT now(),
  seller      jsonb NOT NULL,
  buyer       jsonb NOT NULL,
  description text NOT NULL,
  taxable_inr numeric(12,2) NOT NULL,
  cgst_inr    numeric(12,2) NOT NULL DEFAULT 0,
  sgst_inr    numeric(12,2) NOT NULL DEFAULT 0,
  igst_inr    numeric(12,2) NOT NULL DEFAULT 0,
  total_inr   numeric(12,2) NOT NULL
);
CREATE UNIQUE INDEX invoices_payment ON invoices (payment_id) WHERE kind = 'invoice';
CREATE UNIQUE INDEX invoices_refund ON invoices (refund_id) WHERE kind = 'credit_note';
CREATE INDEX invoices_org ON invoices (org_id, issued_at DESC);
CREATE TABLE invoice_counters (
  series text PRIMARY KEY,                           -- e.g. 'INV/2026-27'
  last   integer NOT NULL DEFAULT 0
);

-- Every webhook from the payment gateway, as received.
CREATE TABLE payment_events (
  id           bigserial PRIMARY KEY,
  at           timestamptz NOT NULL DEFAULT now(),
  provider     text NOT NULL DEFAULT 'cashfree',
  type         text,
  order_id     text,
  signature_ok boolean NOT NULL,
  result       text,
  body         jsonb
);
CREATE INDEX payment_events_at ON payment_events (at DESC);
CREATE INDEX payment_events_order ON payment_events (order_id);
