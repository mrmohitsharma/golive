-- Web onboarding, remembered per user (follows them across devices): the 4-step setup bar
-- and the product tour. {setup: {state, step, eventId}, tour: {state, step, seen[]}, welcomed}
ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding jsonb NOT NULL DEFAULT '{}'::jsonb;
