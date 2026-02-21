ALTER TABLE "screens"
  ADD COLUMN IF NOT EXISTS "pairing_code" text;

ALTER TABLE "screens"
  ADD COLUMN IF NOT EXISTS "pairing_expires_at" timestamp;