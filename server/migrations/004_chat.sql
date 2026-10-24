-- Viewer comments: one feed per tournament combining the CoGolfers watch page chat,
-- YouTube live chat and Facebook live comments. Commentators read out questions;
-- directors moderate and can put a question on air.

CREATE TABLE chat_messages (
  id            bigserial PRIMARY KEY,
  tournament_id uuid NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  source        text NOT NULL CHECK (source IN ('watch', 'youtube', 'facebook')),
  -- Message id on YouTube/Facebook (dedupe when polling); null for watch-page messages.
  external_id   text,
  author        text NOT NULL,
  -- Who wrote it, stable per source: watch viewer id, YouTube channel id, Facebook user id.
  author_key    text NOT NULL,
  text          text NOT NULL,
  is_question   boolean NOT NULL DEFAULT false,
  hidden        boolean NOT NULL DEFAULT false,
  pinned        boolean NOT NULL DEFAULT false,
  answered      boolean NOT NULL DEFAULT false,
  ip_hash       text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX chat_messages_tournament ON chat_messages (tournament_id, id DESC);
CREATE UNIQUE INDEX chat_messages_external ON chat_messages (tournament_id, source, external_id) WHERE external_id IS NOT NULL;

CREATE TABLE chat_bans (
  tournament_id uuid NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  source        text NOT NULL,
  author_key    text NOT NULL,
  author        text,
  banned_by     text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tournament_id, source, author_key)
);

ALTER TABLE tournaments
  -- Viewers can post on the watch page (YouTube/Facebook comments are read either way).
  ADD COLUMN chat_enabled  boolean NOT NULL DEFAULT true,
  -- Seconds between two messages from the same watch-page viewer.
  ADD COLUMN chat_slow_sec integer NOT NULL DEFAULT 3;
