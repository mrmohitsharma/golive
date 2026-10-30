-- V7 web: sessions that can be revoked, and an audit log of admin actions.

-- Bumped to sign a user out everywhere (and when they are disabled or lose admin rights).
ALTER TABLE users ADD COLUMN token_ver integer NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN last_login_at timestamptz;

-- Every change made by a platform admin (or by an admin logged in as a club owner).
CREATE TABLE audit_log (
  id              bigserial PRIMARY KEY,
  at              timestamptz NOT NULL DEFAULT now(),
  actor_id        uuid REFERENCES users(id) ON DELETE SET NULL,
  actor_email     text NOT NULL,
  as_user_id      uuid REFERENCES users(id) ON DELETE SET NULL,   -- set while logged in as someone
  as_user_email   text,
  action          text NOT NULL,                                  -- e.g. "PATCH /api/admin/orgs/:id/billing" or "impersonate.start"
  target_kind     text,
  target_id       text,
  org_id          uuid,
  status          integer,
  detail          jsonb NOT NULL DEFAULT '{}',
  ip              text
);
CREATE INDEX audit_log_at ON audit_log (at DESC);
CREATE INDEX audit_log_actor ON audit_log (actor_id, at DESC);
CREATE INDEX audit_log_org ON audit_log (org_id, at DESC);
