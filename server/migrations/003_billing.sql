-- Billing: free allowance per tournament, paid extra cameras, paid live minutes, a credit
-- wallet per club, credit packs bought through Cashfree, and the CoGolfers admin panel.
-- Amounts in credits are stored in hundredths ("cc") so 2.5 credits per minute is exact.

-- One row of platform-wide settings, edited in /admin.
CREATE TABLE platform_settings (
  id         boolean PRIMARY KEY DEFAULT true CHECK (id),
  pricing    jsonb NOT NULL DEFAULT '{}'::jsonb,   -- see billing.ts DEFAULT_PRICING
  packs      jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{id,label,priceInr,credits}]
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO platform_settings (id) VALUES (true);

-- Wallet and per-club settings. Created on first use.
CREATE TABLE org_billing (
  org_id           uuid PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
  balance_cc       bigint NOT NULL DEFAULT 0,
  -- Any subset of the pricing keys; overrides the platform price for this club only.
  overrides        jsonb NOT NULL DEFAULT '{}'::jsonb,
  suspended        boolean NOT NULL DEFAULT false,
  suspended_reason text,
  billing_name     text,
  billing_phone    text,
  billing_email    text,
  gstin            text,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- Every change to a wallet. Live minutes use one line per broadcast session that grows
-- while live (ref = minutes:<tournament>:<session start>), so a 5-hour show is one line.
CREATE TABLE wallet_tx (
  id            bigserial PRIMARY KEY,
  org_id        uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('purchase', 'cameras', 'minutes', 'admin', 'refund')),
  amount_cc     bigint NOT NULL,
  quantity      integer,              -- cameras bought, or minutes charged
  tournament_id uuid REFERENCES tournaments(id) ON DELETE SET NULL,
  ref           text,
  note          text,
  created_by    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX wallet_tx_org ON wallet_tx (org_id, created_at DESC);
CREATE UNIQUE INDEX wallet_tx_ref ON wallet_tx (kind, ref) WHERE ref IS NOT NULL;

-- Per tournament: camera slots bought, live time used, minutes charged.
ALTER TABLE tournaments
  ADD COLUMN extra_cameras   integer NOT NULL DEFAULT 0,
  ADD COLUMN live_seconds    integer NOT NULL DEFAULT 0,
  ADD COLUMN billed_minutes  integer NOT NULL DEFAULT 0,
  ADD COLUMN grace_seconds   integer NOT NULL DEFAULT 0,
  ADD COLUMN live_session_at timestamptz;

-- Credit purchases (Cashfree orders).
CREATE TABLE payments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  provider     text NOT NULL DEFAULT 'cashfree',
  order_id     text NOT NULL UNIQUE,
  pack_id      text,
  amount_inr   numeric(12,2) NOT NULL,
  credits_cc   bigint NOT NULL,
  status       text NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'paid', 'failed', 'expired')),
  session_id   text,
  provider_ref text,
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  paid_at      timestamptz
);
CREATE INDEX payments_org ON payments (org_id, created_at DESC);
