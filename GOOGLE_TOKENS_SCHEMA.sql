-- Google OAuth Tokens table for Beatrice
-- Run this in your Supabase SQL editor

CREATE TABLE IF NOT EXISTS google_tokens (
  uid TEXT PRIMARY KEY,
  access_token TEXT NOT NULL,
  expires_at BIGINT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
