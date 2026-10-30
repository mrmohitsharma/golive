-- V7: support tickets (anyone can raise one: website visitors, club members, from the web app).
CREATE SEQUENCE ticket_number START 1001;

CREATE TABLE tickets (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number          integer NOT NULL UNIQUE DEFAULT nextval('ticket_number'),
  public_key      text NOT NULL UNIQUE,                 -- the requester's private link /support/t/<key>
  subject         text NOT NULL,
  category        text NOT NULL CHECK (category IN ('streaming', 'billing', 'account', 'bug', 'question', 'other')),
  priority        text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'pending', 'resolved', 'closed')),
  requester_name  text NOT NULL,
  requester_email text NOT NULL,
  user_id         uuid REFERENCES users(id) ON DELETE SET NULL,
  org_id          uuid REFERENCES orgs(id) ON DELETE SET NULL,
  tournament_id   uuid REFERENCES tournaments(id) ON DELETE SET NULL,
  assigned_to     uuid REFERENCES users(id) ON DELETE SET NULL,
  last_reply_by   text NOT NULL DEFAULT 'customer' CHECK (last_reply_by IN ('customer', 'team')),
  ip_hash         text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tickets_status ON tickets (status, updated_at DESC);
CREATE INDEX tickets_email ON tickets (lower(requester_email), created_at DESC);
CREATE INDEX tickets_user ON tickets (user_id, created_at DESC);

CREATE TABLE ticket_messages (
  id             bigserial PRIMARY KEY,
  ticket_id      uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  author_kind    text NOT NULL CHECK (author_kind IN ('customer', 'team', 'system')),
  author_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  author_name    text NOT NULL,
  body           text NOT NULL,
  internal       boolean NOT NULL DEFAULT false,          -- team notes the requester never sees
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ticket_messages_ticket ON ticket_messages (ticket_id, id);

CREATE TABLE ticket_files (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id  uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  message_id bigint REFERENCES ticket_messages(id) ON DELETE CASCADE,
  name       text NOT NULL,
  mime       text NOT NULL,
  size_bytes integer NOT NULL,
  path       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
