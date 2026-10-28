-- Sign in with Google (onboarding P1-2): an account may have no password, only a Google
-- identity. An existing email account is linked to Google the first time its owner signs
-- in with Google (Google has verified the email).
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
ALTER TABLE users ADD COLUMN google_sub text UNIQUE;
