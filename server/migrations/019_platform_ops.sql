-- V7 admin: platform switches and cost model, daily usage for cost reports, data requests.

-- {"signupEnabled": bool, "costs": {...}}: overrides the server config where set.
ALTER TABLE platform_settings ADD COLUMN platform jsonb NOT NULL DEFAULT '{}';

-- Live seconds and camera-seconds per event per day (IST), counted by the billing meter.
CREATE TABLE usage_daily (
  day            date NOT NULL,
  tournament_id  uuid NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  org_id         uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  mode           text NOT NULL,
  live_seconds   integer NOT NULL DEFAULT 0,
  camera_seconds bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (day, tournament_id)
);
CREATE INDEX usage_daily_org ON usage_daily (org_id, day);

-- Data protection requests (DPDP): delete or export someone's data.
CREATE TABLE data_requests (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email      text NOT NULL,
  kind       text NOT NULL CHECK (kind IN ('delete_account', 'delete_club', 'export', 'correct')),
  details    text,
  status     text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'rejected')),
  note       text,
  created_at timestamptz NOT NULL DEFAULT now(),
  done_at    timestamptz,
  done_by    text
);
CREATE INDEX data_requests_status ON data_requests (status, created_at DESC);
