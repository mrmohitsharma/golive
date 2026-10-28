-- Event types (onboarding P1-5): Go Live is not only golf. The type picks the default
-- graphics and the words the app uses (a wedding shows names, a conference speaker titles).
-- Events made before this are golf.
ALTER TABLE tournaments ADD COLUMN event_type text NOT NULL DEFAULT 'golf'
  CHECK (event_type IN ('golf', 'cricket', 'football', 'wedding', 'concert', 'conference', 'other'));
