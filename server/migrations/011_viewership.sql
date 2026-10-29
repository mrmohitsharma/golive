-- Viewership engine, step 1: who watches on the watch page and for how long.
-- Viewers are anonymous: a random id kept in the browser, no name, no IP address stored
-- (only a salted hash of the network, to cap fake views from one network).

-- Stream clock: the event's first Go live. Never reset when the stream restarts.
ALTER TABLE tournaments ADD COLUMN first_live_at timestamptz;

CREATE TABLE viewers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id uuid NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  viewer_key    text NOT NULL,                       -- random id from the browser
  ref_id        uuid,                                -- influencer link that brought them (step 2)
  device        text NOT NULL DEFAULT 'other',       -- mobile | tablet | desktop | other
  app           text NOT NULL DEFAULT 'browser',     -- instagram | facebook | whatsapp | browser
  net_hash      text,
  flagged       boolean NOT NULL DEFAULT false,      -- bot or over the per-network cap: not counted
  visits        integer NOT NULL DEFAULT 1,
  watched_sec   integer NOT NULL DEFAULT 0,          -- viewer clock: seconds actually watched
  unmuted_sec   integer NOT NULL DEFAULT 0,
  live_sec      integer NOT NULL DEFAULT 0,
  replay_sec    integer NOT NULL DEFAULT 0,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tournament_id, viewer_key)
);
CREATE INDEX viewers_tournament ON viewers (tournament_id, last_seen_at);
CREATE INDEX viewers_net ON viewers (tournament_id, net_hash);

-- One row per event per minute: how many were watching (and unmuted), and YouTube's own count.
CREATE TABLE viewer_minutes (
  tournament_id uuid NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  at            timestamptz NOT NULL,
  watching      integer NOT NULL,
  unmuted       integer NOT NULL,
  youtube       integer,
  PRIMARY KEY (tournament_id, at)
);
