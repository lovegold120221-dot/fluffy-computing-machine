-- Google OAuth Tokens table for Beatrice
-- Run this in your Supabase SQL editor

CREATE TABLE IF NOT EXISTS google_tokens (
  uid TEXT PRIMARY KEY,
  access_token TEXT NOT NULL,
  refresh_token TEXT,
  expires_at BIGINT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- If table already exists, add refresh_token column
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'google_tokens' AND column_name = 'refresh_token'
  ) THEN
    ALTER TABLE google_tokens ADD COLUMN refresh_token TEXT;
  END IF;
END $$;
