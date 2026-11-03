-- Viewer-minute billing: X credits per viewer-minute (watch page exact, YouTube and Facebook
-- from their per-minute "watching now" counts), on top of live minutes.

-- Facebook's live viewer count per minute, next to YouTube's.
ALTER TABLE viewer_minutes ADD COLUMN IF NOT EXISTS facebook integer;

-- Welcome allowance: free viewer-seconds a club can use on any events. Existing clubs get the
-- default 100 viewer-minutes once; new clubs get the admin's current setting (set by the code).
ALTER TABLE org_billing ADD COLUMN IF NOT EXISTS free_viewer_sec bigint NOT NULL DEFAULT 6000;
ALTER TABLE org_billing ALTER COLUMN free_viewer_sec SET DEFAULT 0;

-- Per event: viewer-seconds counted so far (all sources), taken from the free allowance,
-- billable, and credits charged for them (hundredths).
ALTER TABLE tournaments
  ADD COLUMN IF NOT EXISTS viewer_sec_counted  bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS viewer_sec_free     bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS viewer_sec_billable bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS viewer_cc_billed    bigint NOT NULL DEFAULT 0;

-- Viewing before this change is never billed.
UPDATE tournaments t SET viewer_sec_counted =
  COALESCE((SELECT sum(live_sec) FROM viewers v WHERE v.tournament_id = t.id AND NOT v.flagged), 0)
  + 60 * COALESCE((SELECT sum(COALESCE(youtube, 0)) FROM viewer_minutes m WHERE m.tournament_id = t.id), 0);

ALTER TABLE wallet_tx DROP CONSTRAINT IF EXISTS wallet_tx_kind_check;
ALTER TABLE wallet_tx ADD CONSTRAINT wallet_tx_kind_check
  CHECK (kind IN ('purchase', 'cameras', 'minutes', 'admin', 'refund', 'destinations', 'viewership', 'messages', 'viewers'));
