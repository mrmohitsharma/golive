-- V9: the daily gift limit per club reads a club's paid gifts of the last day.
CREATE INDEX IF NOT EXISTS gifts_org_paid ON gifts (org_id, paid_at) WHERE status = 'paid';
