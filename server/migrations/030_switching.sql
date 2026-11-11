-- V9: camera switching per event: auto switch (round-robin or a main camera, every N seconds)
-- and the transition used for every switch (Fade or Slide, its duration).
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS switching jsonb NOT NULL DEFAULT '{}';
