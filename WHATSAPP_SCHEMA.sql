-- WhatsApp Connections table for Beatrice Evolution API integration
-- Run this in your Supabase SQL editor

CREATE TABLE IF NOT EXISTS whatsapp_connections (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE,
  instance_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'not_connected'
    CHECK (status IN (
      'not_connected', 'connecting', 'connected', 'disconnected', 'error'
    )),
  phone_number TEXT,
  qr_base64 TEXT,
  pairing_code TEXT,
  last_connection_state TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Add source column to conversations if table exists
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'conversations'
  ) THEN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'conversations' AND column_name = 'source'
    ) THEN
      ALTER TABLE conversations ADD COLUMN source TEXT DEFAULT 'voice';
    END IF;
  END IF;
END $$;

-- Index for webhook lookups
CREATE INDEX IF NOT EXISTS idx_whatsapp_instance
  ON whatsapp_connections(instance_name);
