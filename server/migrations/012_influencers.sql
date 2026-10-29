-- Viewership engine, step 2: influencer links, pre-event reminders and an outbox of messages.

-- Short watch links: /w/<watch_slug>/<influencer slug>.
ALTER TABLE tournaments ADD COLUMN watch_slug text UNIQUE;
-- Credit goes to the first influencer link a viewer opened, if within this many days.
ALTER TABLE tournaments ADD COLUMN attribution_days integer NOT NULL DEFAULT 7;
-- Influencers can see the other influencers' totals on their stats page.
ALTER TABLE tournaments ADD COLUMN influencer_board boolean NOT NULL DEFAULT true;

CREATE TABLE influencers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id uuid NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  name          text NOT NULL,
  handle        text,
  platform      text NOT NULL DEFAULT 'instagram' CHECK (platform IN ('instagram', 'youtube', 'facebook', 'whatsapp', 'x', 'other')),
  slug          text NOT NULL,
  terms         text,                     -- payout terms as agreed (free text)
  pan_enc       text,                     -- PAN, encrypted (for TDS); never shown in full
  stats_key     text NOT NULL UNIQUE,     -- the influencer's private stats page /i/<stats_key>
  archived      boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tournament_id, slug)
);

ALTER TABLE viewers ADD CONSTRAINT viewers_ref_fk FOREIGN KEY (ref_id) REFERENCES influencers(id) ON DELETE SET NULL;
CREATE INDEX viewers_ref ON viewers (tournament_id, ref_id);

-- Every tap on an influencer link (link previews and bots excluded).
CREATE TABLE influencer_clicks (
  id            bigserial PRIMARY KEY,
  influencer_id uuid NOT NULL REFERENCES influencers(id) ON DELETE CASCADE,
  device        text NOT NULL,
  app           text NOT NULL,
  live          boolean NOT NULL,
  at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX influencer_clicks_inf ON influencer_clicks (influencer_id, at);

-- "Remind me" before the event: a phone number, sent a message when the stream starts.
CREATE TABLE reminders (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id uuid NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  ref_id        uuid REFERENCES influencers(id) ON DELETE SET NULL,
  phone         text NOT NULL,            -- E.164 without +, e.g. 919812345678
  consent_at    timestamptz NOT NULL,
  sent_at       timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tournament_id, phone)
);

-- Every SMS/WhatsApp message (reminders, codes, winner messages): what, to whom (masked), status.
-- Counts toward the event's included messages.
CREATE TABLE messages (
  id            bigserial PRIMARY KEY,
  tournament_id uuid REFERENCES tournaments(id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('reminder', 'otp', 'winner', 'draw_entry')),
  to_masked     text NOT NULL,            -- 91******5678
  provider      text NOT NULL,            -- msg91 | test
  status        text NOT NULL,            -- sent | failed
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_tournament ON messages (tournament_id, created_at);
