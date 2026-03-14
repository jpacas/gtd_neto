-- GTD Neto - Meta table schema
-- Stores contexts, areas, weekly reviews, and feature flags per user

CREATE TABLE IF NOT EXISTS gtd_meta (
  id           TEXT        NOT NULL,
  owner        TEXT        NOT NULL DEFAULT 'default',
  kind         TEXT        NOT NULL, -- 'context' | 'area' | 'weekly_review' | 'feature_flags'
  payload      JSONB       NOT NULL DEFAULT '{}',
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Prefer composite PK; fallback to just id if migration not run
  CONSTRAINT gtd_meta_pkey PRIMARY KEY (id, owner)
);

-- Index for fast per-owner, per-kind lookups
CREATE INDEX IF NOT EXISTS gtd_meta_owner_kind_idx ON gtd_meta (owner, kind);
CREATE INDEX IF NOT EXISTS gtd_meta_updated_at_idx ON gtd_meta (updated_at DESC);

-- Enable Row Level Security (disabled for service role key usage)
ALTER TABLE gtd_meta ENABLE ROW LEVEL SECURITY;

-- Policy: users can only see their own meta (only applies when using anon/user JWT)
CREATE POLICY IF NOT EXISTS "Users see own meta"
  ON gtd_meta FOR ALL
  USING (auth.uid()::text = owner);
