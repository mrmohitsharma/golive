-- V9: the organiser's own UPI QR on the video (bottom right) and the watch page, paid once per event.
-- The QR itself lives in tournaments.branding (branding.upi); this is when it was bought.
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS upi_qr_paid_at timestamptz;

ALTER TABLE wallet_tx DROP CONSTRAINT IF EXISTS wallet_tx_kind_check;
ALTER TABLE wallet_tx ADD CONSTRAINT wallet_tx_kind_check
  CHECK (kind IN ('purchase', 'cameras', 'minutes', 'admin', 'refund', 'destinations', 'viewership', 'messages', 'viewers', 'branding', 'ticker', 'welcome', 'upiqr'));
