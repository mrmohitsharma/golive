-- V9 simple pricing: extra cameras and destinations charged per minute while live (fractional
-- credits in hundredths accrue, whole hundredths are charged), and the welcome credits ledger.
ALTER TABLE tournaments
  ADD COLUMN IF NOT EXISTS cam_cc_accrued  numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cam_cc_billed   bigint  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS dest_cc_accrued numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS dest_cc_billed  bigint  NOT NULL DEFAULT 0;

ALTER TABLE wallet_tx DROP CONSTRAINT IF EXISTS wallet_tx_kind_check;
ALTER TABLE wallet_tx ADD CONSTRAINT wallet_tx_kind_check
  CHECK (kind IN ('purchase', 'cameras', 'minutes', 'admin', 'refund', 'destinations', 'viewership', 'messages', 'viewers', 'branding', 'ticker', 'welcome'));
