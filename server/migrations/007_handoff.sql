-- Web-to-app handoff (onboarding P1-3): someone signed in on the website shows a QR code;
-- the app scans it and is signed in to the same account. One use, 5 minutes. Only a hash
-- of the code is stored.
CREATE TABLE auth_handoffs (
  code_hash  text PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_handoffs_expires ON auth_handoffs (expires_at);
