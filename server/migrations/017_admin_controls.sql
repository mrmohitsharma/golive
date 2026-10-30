-- V7 admin: per-club feature switches and private admin notes.
ALTER TABLE orgs ADD COLUMN features jsonb NOT NULL DEFAULT '{}';   -- {"cloud": false, "viewership": false} turns a feature off
ALTER TABLE orgs ADD COLUMN admin_notes text;
