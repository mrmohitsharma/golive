-- Where an event's main YouTube stream goes (onboarding P1-6, P1-7):
--   org    = the organisation's own connected channel (as before)
--   golive = the platform's own "Go Live" channel, so a brand-new organiser can go live
--            without connecting anything (broadcasts unlisted by default)
--   key    = a stream key pasted from YouTube Studio (no Google sign-in)
CREATE TABLE platform_youtube (
  id                boolean PRIMARY KEY DEFAULT true CHECK (id),
  channel_id        text NOT NULL,
  channel_title     text NOT NULL,
  refresh_token_enc text NOT NULL,
  enabled           boolean NOT NULL DEFAULT true,
  connected_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  connected_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE tournaments ADD COLUMN yt_source text NOT NULL DEFAULT 'org' CHECK (yt_source IN ('org', 'golive', 'key'));
