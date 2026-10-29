-- Onboarding timing (P1-12): when each organisation first made an event, got a camera in,
-- ran a test (mixer up) and went live. orgs.created_at is the sign-up time.
ALTER TABLE orgs ADD COLUMN first_event_at  timestamptz;
ALTER TABLE orgs ADD COLUMN first_camera_at timestamptz;
ALTER TABLE orgs ADD COLUMN first_test_at   timestamptz;
ALTER TABLE orgs ADD COLUMN first_live_at   timestamptz;

-- Organisations that already ran events before this: their checklist is done.
UPDATE orgs o SET
  first_event_at  = e.at,
  first_camera_at = COALESCE((SELECT min(c.created_at) FROM cameras c JOIN tournaments t ON t.id = c.tournament_id WHERE t.org_id = o.id), e.at),
  first_test_at   = e.at,
  first_live_at   = e.at
FROM (SELECT org_id, min(created_at) AS at FROM tournaments GROUP BY org_id) e
WHERE e.org_id = o.id;
