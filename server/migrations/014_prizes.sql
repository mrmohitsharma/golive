-- Viewership engine, step 4: prizes, winners, the lucky draw and claims.

-- Prize settings of a game. pick: how winners are chosen
--   draw          = random draw among eligible players when the run closes (or when the director runs it)
--   first_correct = the first N right answers (quiz now; prediction when settled)
--   spin          = landing on a winning wheel segment, while prizes last
ALTER TABLE moments
  ADD COLUMN pick              text CHECK (pick IN ('draw', 'first_correct', 'spin')),
  ADD COLUMN prize             text,
  ADD COLUMN sponsor           text,
  ADD COLUMN prize_stock       integer,          -- prizes in all (null = no prize)
  ADD COLUMN winners_per_run   integer,          -- at most this many per run
  ADD COLUMN reserves          integer NOT NULL DEFAULT 2,
  ADD COLUMN claim_hours       integer NOT NULL DEFAULT 24,
  ADD COLUMN min_watch_sec     integer NOT NULL DEFAULT 120,  -- eligibility: watched at least this long
  ADD COLUMN need_unmuted      boolean NOT NULL DEFAULT false,
  ADD COLUMN pace_per_hour     integer,          -- spin: at most this many wins in any hour (spreads prizes)
  ADD COLUMN draw_at_sec       integer;          -- lucky draw: run the draw at this stream-clock second

ALTER TABLE tournaments ADD COLUMN prize_terms text;
-- One prize per viewer (and per phone number) per event: the default; organisers can allow more.
ALTER TABLE tournaments ADD COLUMN prizes_per_viewer integer NOT NULL DEFAULT 1;

-- Lucky draw entries: a phone number and consent, one per number and per viewer.
CREATE TABLE draw_entries (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  moment_id     uuid NOT NULL REFERENCES moments(id) ON DELETE CASCADE,
  tournament_id uuid NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  viewer_id     uuid NOT NULL REFERENCES viewers(id) ON DELETE CASCADE,
  ref_id        uuid REFERENCES influencers(id) ON DELETE SET NULL,
  phone         text NOT NULL,
  consent_at    timestamptz NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (moment_id, phone),
  UNIQUE (moment_id, viewer_id)
);

-- Winners. status: won (claim open) -> claimed (phone verified) -> sent; or expired;
-- reserve = drawn as a reserve, becomes won if a winner does not claim in time.
CREATE TABLE wins (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id    uuid NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  moment_id        uuid NOT NULL REFERENCES moments(id) ON DELETE CASCADE,
  run_key          text NOT NULL,
  viewer_id        uuid NOT NULL REFERENCES viewers(id) ON DELETE CASCADE,
  prize            text NOT NULL,
  sponsor          text,
  status           text NOT NULL CHECK (status IN ('won', 'reserve', 'claimed', 'sent', 'expired')),
  reserve_rank     integer,
  claim_code       text NOT NULL UNIQUE,
  claim_expires_at timestamptz,
  phone            text,                     -- from the draw entry, or given at claim
  email            text,
  otp_hash         text,
  otp_expires_at   timestamptz,
  otp_tries        integer NOT NULL DEFAULT 0,
  otp_sends        integer NOT NULL DEFAULT 0,
  consent_at       timestamptz,
  notified_at      timestamptz,
  claimed_at       timestamptz,
  sent_at          timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX wins_tournament ON wins (tournament_id, status);
CREATE INDEX wins_viewer ON wins (viewer_id);

-- Fairness log: every draw, who was eligible and who was picked.
CREATE TABLE draw_log (
  id            bigserial PRIMARY KEY,
  tournament_id uuid NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  moment_id     uuid NOT NULL REFERENCES moments(id) ON DELETE CASCADE,
  run_key       text NOT NULL,
  method        text NOT NULL,
  eligible      integer NOT NULL,
  picked        jsonb NOT NULL,              -- [{viewer, win, reserve}]
  by            text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (moment_id, run_key)
);

-- Winners' shares: viewers who came through a winner's (or any viewer's) share link.
ALTER TABLE viewers ADD COLUMN share_code text UNIQUE;
ALTER TABLE viewers ADD COLUMN shared_by uuid REFERENCES viewers(id) ON DELETE SET NULL;
