-- Viewership engine, step 3: games on the watch page ("moments").
-- Each moment runs on one of three clocks:
--   viewer   = this viewer's watched seconds (every viewer has their own run)
--   stream   = seconds since the event's first Go live (one run for everyone)
--   director = fired live from the control room (one run for everyone watching then)

ALTER TABLE tournaments ADD COLUMN moment_gap_sec integer NOT NULL DEFAULT 60;

CREATE TABLE moments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id    uuid NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  type             text NOT NULL CHECK (type IN ('quiz', 'poll', 'spin', 'prediction', 'draw')),
  title            text NOT NULL,
  question         text,
  -- [{id, text, weight?, win?}]: answers (quiz, poll, prediction) or wheel segments (spin)
  options          jsonb NOT NULL DEFAULT '[]'::jsonb,
  correct_option   text,                         -- quiz: the right answer; prediction: set when settled
  clock            text NOT NULL CHECK (clock IN ('viewer', 'stream', 'director')),
  at_sec           integer,                      -- viewer / stream clock: when it first shows
  repeat_every_sec integer,                      -- then again every N seconds…
  repeat_max       integer NOT NULL DEFAULT 1,   -- …up to this many times in all
  open_sec         integer NOT NULL DEFAULT 60,  -- how long it stays playable
  audience         text NOT NULL DEFAULT 'all' CHECK (audience IN ('all', 'unmuted', 'ref', 'new', 'returning')),
  audience_ref     uuid REFERENCES influencers(id) ON DELETE SET NULL,
  late_join        boolean NOT NULL DEFAULT false, -- shared moments: show to viewers who join after it closed
  enabled          boolean NOT NULL DEFAULT true,
  sort             integer NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX moments_tournament ON moments (tournament_id, sort);

-- Shared runs (stream and director clocks): when one opened and when it closes.
CREATE TABLE moment_runs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  moment_id      uuid NOT NULL REFERENCES moments(id) ON DELETE CASCADE,
  tournament_id  uuid NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  run_no         integer NOT NULL,
  started_at     timestamptz NOT NULL DEFAULT now(),
  closes_at      timestamptz NOT NULL,
  fired_by       text NOT NULL DEFAULT 'schedule',   -- schedule | <user email>
  correct_option text,                               -- prediction settled for this run
  UNIQUE (moment_id, run_no)
);
CREATE INDEX moment_runs_open ON moment_runs (tournament_id, closes_at);

-- One row per viewer per run: shown, played (answer and result) or closed.
-- run_key = the shared run's id, or "v<n>" for the viewer's own n-th run of a viewer-clock moment.
CREATE TABLE moment_plays (
  id              bigserial PRIMARY KEY,
  moment_id       uuid NOT NULL REFERENCES moments(id) ON DELETE CASCADE,
  tournament_id   uuid NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  run_key         text NOT NULL,
  viewer_id       uuid NOT NULL REFERENCES viewers(id) ON DELETE CASCADE,
  watched_at_show integer NOT NULL DEFAULT 0,        -- viewer clock when shown (for "extra watch time")
  shown_at        timestamptz NOT NULL DEFAULT now(),
  played_at       timestamptz,
  dismissed_at    timestamptz,
  answer          text,
  correct         boolean,
  result          jsonb,
  UNIQUE (moment_id, run_key, viewer_id)
);
CREATE INDEX moment_plays_viewer ON moment_plays (tournament_id, viewer_id);
