-- V7: emails (SMTP), password reset, return to the web after paying, billing alerts.

-- Every email we send (or would send when SMTP is not set up), for the admin log.
CREATE TABLE emails (
  id         bigserial PRIMARY KEY,
  to_email   text NOT NULL,
  subject    text NOT NULL,
  kind       text NOT NULL,                    -- welcome, password_reset, receipt, refund, low_balance, suspended, ticket, test
  status     text NOT NULL CHECK (status IN ('sent', 'failed', 'not_sent')),
  error      text,
  ref        text,                             -- dedupe key, e.g. "receipt:<payment id>"
  org_id     uuid REFERENCES orgs(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX emails_ref ON emails (ref) WHERE ref IS NOT NULL AND status = 'sent';
CREATE INDEX emails_at ON emails (created_at DESC);

CREATE TABLE password_resets (
  token_hash text PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX password_resets_user ON password_resets (user_id, created_at DESC);

-- Where the payer goes back to after Cashfree (e.g. /web/wallet), only paths on this site.
ALTER TABLE payments ADD COLUMN return_path text;

-- Low-credit email at most once a day per club.
ALTER TABLE org_billing ADD COLUMN low_balance_emailed_at timestamptz;
