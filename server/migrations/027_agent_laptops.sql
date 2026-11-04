-- V8 Laptop OBS made easy: a club pairs its laptop once with a 6-digit code (no .env), then
-- picks which event it runs from the event page.
CREATE TABLE IF NOT EXISTS agent_laptops (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name text NOT NULL,
  os text,
  version text,
  token_hash text NOT NULL,
  -- The event this laptop runs now (one laptop per event, one event per laptop).
  tournament_id uuid REFERENCES tournaments(id) ON DELETE SET NULL,
  paired_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz,
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS agent_laptops_org ON agent_laptops (org_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS agent_laptops_tournament ON agent_laptops (tournament_id) WHERE revoked_at IS NULL;

-- A code shown by the agent on a laptop that is not paired yet (valid 10 minutes).
CREATE TABLE IF NOT EXISTS agent_pairings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL,
  secret_hash text NOT NULL,
  name text,
  os text,
  version text,
  expires_at timestamptz NOT NULL,
  laptop_id uuid REFERENCES agent_laptops(id) ON DELETE CASCADE,
  -- Handed to the agent once when it next asks, then cleared.
  laptop_token text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_pairings_code ON agent_pairings (code);
