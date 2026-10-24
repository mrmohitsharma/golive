-- CoGolfer Live Director: schema v2 (organisations, self-serve, production modes,
-- scoring, graphics, replay/clips, commentary). Replaces the v1 schema: nothing was
-- deployed on v1, so this is a clean schema rather than a chain of migrations.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------- people and clubs
CREATE TABLE users (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email             text NOT NULL UNIQUE,
  name              text NOT NULL,
  password_hash     text NOT NULL,
  is_platform_admin boolean NOT NULL DEFAULT false,
  disabled          boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- A club, academy or event organiser. Everything else belongs to one.
CREATE TABLE orgs (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE org_members (
  org_id     uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('owner', 'director', 'scorer', 'commentator', 'camera')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id)
);

-- One YouTube channel per organisation, connected once with Google OAuth.
CREATE TABLE org_youtube (
  org_id            uuid PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
  channel_id        text NOT NULL,
  channel_title     text NOT NULL,
  refresh_token_enc text NOT NULL,
  connected_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  connected_at      timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- tournaments
CREATE TABLE tournaments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name            text NOT NULL,
  venue           text,
  starts_on       date,
  -- Secrets: OBS reads camera feeds with read_key; the OBS agent authenticates with
  -- engine_key; the graphics overlay page uses graphics_key. Never sent to camera apps.
  read_key        text NOT NULL,
  engine_key      text NOT NULL,
  graphics_key    text NOT NULL,
  production_mode text NOT NULL DEFAULT 'laptop' CHECK (production_mode IN ('laptop', 'cloud')),
  auto_fallback   boolean NOT NULL DEFAULT true,
  archived        boolean NOT NULL DEFAULT false,
  graphics        jsonb NOT NULL DEFAULT '{}'::jsonb,
  audio           jsonb NOT NULL DEFAULT '{}'::jsonb,
  cloud_engine    jsonb NOT NULL DEFAULT '{}'::jsonb,
  yt_broadcast_id text,
  yt_stream_id    text,
  yt_stream_key_enc text,
  yt_ingest_url   text,
  yt_privacy      text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tournaments_org ON tournaments (org_id);

-- Codes behind the QR posters: volunteers join as camera, scorer or commentator
-- without creating an account.
CREATE TABLE join_codes (
  code          text PRIMARY KEY,
  tournament_id uuid NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  role          text NOT NULL CHECK (role IN ('camera', 'scorer', 'commentator')),
  label         text,
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz,
  revoked       boolean NOT NULL DEFAULT false,
  uses          integer NOT NULL DEFAULT 0
);
CREATE INDEX join_codes_tournament ON join_codes (tournament_id);

-- ---------------------------------------------------------------- sources
CREATE TABLE cameras (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id   uuid NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  name            text NOT NULL,
  hole            integer CHECK (hole IS NULL OR (hole >= 1 AND hole <= 36)),
  position        text,
  stream_path     text NOT NULL UNIQUE,
  publish_key     text NOT NULL,
  device_id       text NOT NULL,
  device_platform text CHECK (device_platform IS NULL OR device_platform IN ('android', 'ios', 'other')),
  device_model    text,
  -- "user:<uuid>" or "guest:<id>": who may read the publish URL.
  owner           text NOT NULL,
  sort_order      integer NOT NULL DEFAULT 0,
  last_telemetry  jsonb,
  last_seen_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tournament_id, name),
  UNIQUE (tournament_id, device_id)
);

CREATE TABLE commentators (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id uuid NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  name          text NOT NULL,
  stream_path   text NOT NULL UNIQUE,
  publish_key   text NOT NULL,
  device_id     text NOT NULL,
  owner         text NOT NULL,
  sort_order    integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tournament_id, device_id)
);

-- ---------------------------------------------------------------- scoring
CREATE TABLE holes (
  tournament_id uuid NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  number        integer NOT NULL CHECK (number >= 1 AND number <= 36),
  par           integer NOT NULL CHECK (par >= 3 AND par <= 6),
  yardage       integer CHECK (yardage IS NULL OR (yardage > 0 AND yardage < 1000)),
  PRIMARY KEY (tournament_id, number)
);

CREATE TABLE players (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id uuid NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  name          text NOT NULL,
  club          text,
  category      text,
  group_no      integer,
  sort_order    integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX players_tournament ON players (tournament_id);

CREATE TABLE scores (
  tournament_id uuid NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  player_id     uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  hole          integer NOT NULL,
  strokes       integer NOT NULL CHECK (strokes >= 1 AND strokes <= 20),
  updated_by    text,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, hole)
);
CREATE INDEX scores_tournament ON scores (tournament_id);

-- ---------------------------------------------------------------- clips
CREATE TABLE clips (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id uuid NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  camera_id     uuid REFERENCES cameras(id) ON DELETE SET NULL,
  camera_name   text NOT NULL,
  hole          integer,
  title         text,
  start_at      timestamptz NOT NULL,
  duration_sec  numeric NOT NULL,
  status        text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'processing', 'ready', 'failed')),
  error         text,
  size_bytes    bigint,
  created_by    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  ready_at      timestamptz
);
CREATE INDEX clips_tournament ON clips (tournament_id, created_at DESC);

-- ---------------------------------------------------------------- audit
CREATE TABLE switch_log (
  id            bigserial PRIMARY KEY,
  tournament_id uuid NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  actor         text,
  action        text NOT NULL,
  camera_id     uuid,
  ok            boolean NOT NULL,
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
