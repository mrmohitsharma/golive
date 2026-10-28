-- More than one destination per platform: an organisation can connect several YouTube
-- channels (the first connected channel stays in org_youtube as the main one), and each
-- event can add extra destinations: a connected channel, or any stream URL + key
-- (YouTube, Facebook, Instagram or another RTMP service). The first destination of an
-- event is free; each extra one is bought per event (tournaments.extra_destinations).

-- Extra YouTube channels connected with Google sign-in.
CREATE TABLE youtube_channels (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  channel_id        text NOT NULL,
  channel_title     text NOT NULL,
  refresh_token_enc text NOT NULL,
  connected_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  connected_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, channel_id)
);

-- Extra destinations of one event (the main YouTube / Facebook / Instagram stay in tournaments).
CREATE TABLE event_destinations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id   uuid NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  kind            text NOT NULL CHECK (kind IN ('channel', 'key')),
  platform        text NOT NULL CHECK (platform IN ('youtube', 'facebook', 'instagram', 'other')),
  label           text NOT NULL,
  -- kind = channel: the connected channel and the broadcast made on it for this event.
  channel_id      uuid REFERENCES youtube_channels(id) ON DELETE CASCADE,
  privacy         text CHECK (privacy IN ('public', 'unlisted', 'private')),
  yt_broadcast_id text,
  yt_stream_id    text,
  -- Full RTMP(S) URL including the stream key, encrypted (kind = key, or the channel broadcast's ingest).
  url_enc         text,
  hint            text,                 -- last characters of the key, to recognise it
  vertical        boolean NOT NULL DEFAULT false,  -- 9:16 re-encode (Instagram)
  enabled         boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (kind <> 'channel' OR channel_id IS NOT NULL)
);
CREATE INDEX event_destinations_tournament ON event_destinations (tournament_id, created_at);

ALTER TABLE tournaments ADD COLUMN extra_destinations integer NOT NULL DEFAULT 0;

ALTER TABLE wallet_tx DROP CONSTRAINT IF EXISTS wallet_tx_kind_check;
ALTER TABLE wallet_tx ADD CONSTRAINT wallet_tx_kind_check CHECK (kind IN ('purchase', 'cameras', 'minutes', 'admin', 'refund', 'destinations'));
