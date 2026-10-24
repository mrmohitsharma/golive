-- Multistreaming (YouTube + Facebook + Instagram) and the public watch page.

-- OBS sends ONE programme stream to MediaMTX (path prog-<tournament id>); the server
-- forwards it to each platform. output_key authorises that publish.
ALTER TABLE tournaments
  ADD COLUMN output_key   text,
  -- {"youtube":{"enabled":true},"facebook":{"enabled":false},"instagram":{"enabled":false,"urlEnc":"…"}}
  ADD COLUMN outputs      jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Listed on /api/public/live and the /watch page.
  ADD COLUMN public_watch boolean NOT NULL DEFAULT true,
  -- Current Facebook live video for this tournament (created at "Go live", ended at "End").
  ADD COLUMN fb_live_video_id   text,
  ADD COLUMN fb_stream_url_enc  text,
  ADD COLUMN fb_permalink       text;

-- One connected Facebook account per organisation, with the Pages it manages.
-- Page tokens (sealed) are long-lived: derived from a long-lived user token.
CREATE TABLE org_facebook (
  org_id        uuid PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
  user_name     text NOT NULL,
  pages         jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{"id","name","tokenEnc"}]
  page_id       text,
  connected_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  connected_at  timestamptz NOT NULL DEFAULT now()
);

-- Clips shown on the public watch page unless a director hides them.
ALTER TABLE clips ADD COLUMN public boolean NOT NULL DEFAULT true;
