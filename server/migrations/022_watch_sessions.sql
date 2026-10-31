-- Our own watch player: one row per HLS session (a new one each time the programme restarts).
-- Files live under HLS_DIR/<tournament>/<name>/; a finished session becomes the replay.
CREATE TABLE watch_sessions (
  id bigserial PRIMARY KEY,
  tournament_id uuid NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  name text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  duration_sec int,
  bytes bigint,
  deleted_at timestamptz,
  UNIQUE (tournament_id, name)
);
CREATE INDEX watch_sessions_tournament ON watch_sessions (tournament_id, started_at DESC);
