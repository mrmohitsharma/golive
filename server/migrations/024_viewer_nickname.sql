-- Watch page: a viewer's optional name on the games leaderboard (Top players).
ALTER TABLE viewers ADD COLUMN IF NOT EXISTS nickname text;
CREATE INDEX IF NOT EXISTS moment_plays_points ON moment_plays (tournament_id) WHERE played_at IS NOT NULL;
