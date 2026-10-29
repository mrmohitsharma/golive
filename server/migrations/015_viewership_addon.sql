-- Viewership engine, step 5: the paid add-on per event (influencer links, games, prizes,
-- reminders), with a number of SMS messages included and a price per message after that.
ALTER TABLE tournaments ADD COLUMN viewership_on_at timestamptz;
ALTER TABLE wallet_tx DROP CONSTRAINT IF EXISTS wallet_tx_kind_check;
ALTER TABLE wallet_tx ADD CONSTRAINT wallet_tx_kind_check CHECK (kind IN ('purchase', 'cameras', 'minutes', 'admin', 'refund', 'destinations', 'viewership', 'messages'));
-- Retention: when a viewer's identifiers were removed (reports keep the counts).
ALTER TABLE viewers ADD COLUMN anonymised_at timestamptz;
ALTER TABLE viewers ALTER COLUMN viewer_key DROP NOT NULL;
