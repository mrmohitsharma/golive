-- V8 event branding: watch-page theme and logo, video watermark, scrolling ticker.
ALTER TABLE tournaments
  ADD COLUMN IF NOT EXISTS branding jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Bought per event (prices in admin): own logo + watermark, and the ticker.
  ADD COLUMN IF NOT EXISTS branding_paid_at timestamptz,
  ADD COLUMN IF NOT EXISTS ticker_paid_at timestamptz;

ALTER TABLE wallet_tx DROP CONSTRAINT IF EXISTS wallet_tx_kind_check;
ALTER TABLE wallet_tx ADD CONSTRAINT wallet_tx_kind_check
  CHECK (kind IN ('purchase', 'cameras', 'minutes', 'admin', 'refund', 'destinations', 'viewership', 'messages', 'viewers', 'branding', 'ticker'));
