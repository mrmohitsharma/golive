-- V9: brand channels (<brand>.gogetslive.com) and gift credits (viewers gift the organiser
-- during a live show; Go Live keeps a share; organisers are paid out every 7 days).

-- ---------------------------------------------------------------- brand channels
CREATE TABLE IF NOT EXISTS channels (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL UNIQUE REFERENCES orgs(id) ON DELETE CASCADE,
  -- The subdomain: <slug>.gogetslive.com
  slug          text NOT NULL UNIQUE,
  name          text NOT NULL,
  description   text NOT NULL DEFAULT '',
  -- {theme, accent, logo:{file,v}, links:[{label,url}], sponsors:[text]}
  look          jsonb NOT NULL DEFAULT '{}',
  public        boolean NOT NULL DEFAULT true,
  featured_tournament_id uuid REFERENCES tournaments(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Per event on the channel: hidden from the channel, its series or season, a start time for
-- the countdown and the reminder email.
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS channel_hidden boolean NOT NULL DEFAULT false;
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS series text;
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS starts_at timestamptz;
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS reminded_at timestamptz;
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS live_alerted_at timestamptz;

CREATE TABLE IF NOT EXISTS channel_followers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id    uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  email         text NOT NULL,
  token         text NOT NULL UNIQUE,
  verified_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel_id, email)
);
CREATE INDEX IF NOT EXISTS channel_followers_verified ON channel_followers (channel_id) WHERE verified_at IS NOT NULL;

-- ---------------------------------------------------------------- gift credits
ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS gifts jsonb NOT NULL DEFAULT '{}';
-- Per-club overrides of the platform gift settings (share, limits, on/off).
ALTER TABLE org_billing ADD COLUMN IF NOT EXISTS gift_overrides jsonb NOT NULL DEFAULT '{}';
-- Per-event gift setup: on/off, stickers, custom amounts, video, goal, top supporters, approval.
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS gifts jsonb NOT NULL DEFAULT '{}';

CREATE TABLE IF NOT EXISTS gifts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id uuid NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  org_id        uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  order_id      text NOT NULL UNIQUE,
  session_id    text,
  status        text NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'paid', 'failed', 'expired', 'refunded')),
  sender_name   text NOT NULL,
  message       text,
  sticker       jsonb NOT NULL DEFAULT '{}',
  amount_inr    numeric(12, 2) NOT NULL,
  -- The split, fixed when the gift is paid (settings can change later).
  gst_inr       numeric(12, 2),
  fee_inr       numeric(12, 2),
  share_inr     numeric(12, 2),
  tds_inr       numeric(12, 2),
  net_inr       numeric(12, 2),
  split         jsonb,
  -- Shown in chat and the video: approval (when the organiser holds messages) and hiding.
  approved      boolean NOT NULL DEFAULT true,
  hidden        boolean NOT NULL DEFAULT false,
  in_video      boolean NOT NULL DEFAULT false,
  chat_message_id bigint,
  device_hash   text,
  ip_hash       text,
  paid_at       timestamptz,
  payable_at    timestamptz,
  payout_id     uuid,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS gifts_tournament ON gifts (tournament_id, created_at DESC);
CREATE INDEX IF NOT EXISTS gifts_payable ON gifts (org_id, payable_at) WHERE status = 'paid' AND payout_id IS NULL;
CREATE INDEX IF NOT EXISTS gifts_device ON gifts (device_hash, created_at) WHERE status = 'paid';

ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS gift jsonb;

-- Where a club's gift money goes. Account number and PAN are sealed (encrypted).
CREATE TABLE IF NOT EXISTS payee_accounts (
  org_id        uuid PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
  legal_name    text NOT NULL,
  pan_enc       text NOT NULL,
  pan_last4     text NOT NULL,
  account_holder text NOT NULL,
  account_enc   text NOT NULL,
  account_last4 text NOT NULL,
  ifsc          text NOT NULL,
  gstin         text,
  email         text NOT NULL,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'rejected')),
  status_note   text,
  verified_by   text,
  verified_at   timestamptz,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- The payout agreement: emailed to the club, signed by opening the link and typing a name.
CREATE TABLE IF NOT EXISTS payout_agreements (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  version       text NOT NULL,
  text          text NOT NULL,
  text_hash     text NOT NULL,
  sent_to       text NOT NULL,
  token_hash    text NOT NULL UNIQUE,
  sent_by       text,
  sent_at       timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  signed_at     timestamptz,
  signer_name   text,
  signer_ip     text,
  signer_agent  text,
  revoked_at    timestamptz
);
CREATE INDEX IF NOT EXISTS payout_agreements_org ON payout_agreements (org_id, sent_at DESC);

CREATE TABLE IF NOT EXISTS gift_payouts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  gift_count    integer NOT NULL,
  gross_inr     numeric(12, 2) NOT NULL,
  gst_inr       numeric(12, 2) NOT NULL,
  fee_inr       numeric(12, 2) NOT NULL,
  share_inr     numeric(12, 2) NOT NULL,
  tds_inr       numeric(12, 2) NOT NULL,
  net_inr       numeric(12, 2) NOT NULL,
  status        text NOT NULL DEFAULT 'due' CHECK (status IN ('due', 'paid', 'cancelled')),
  utr           text,
  created_by    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  paid_by       text,
  paid_at       timestamptz
);
CREATE INDEX IF NOT EXISTS gift_payouts_org ON gift_payouts (org_id, created_at DESC);
