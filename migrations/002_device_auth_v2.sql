-- Device auth v2: fast lookup + rotation/revocation + optional pairing + optional mTLS binding

ALTER TABLE screens
  ADD COLUMN IF NOT EXISTS api_key_hash TEXT,
  ADD COLUMN IF NOT EXISTS api_key_last4 TEXT,
  ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rotated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS token_version INT NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS pairing_code_hash TEXT,
  ADD COLUMN IF NOT EXISTS pairing_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS mtls_fingerprint TEXT;

CREATE INDEX IF NOT EXISTS idx_screens_api_key_hash ON screens(api_key_hash);
CREATE INDEX IF NOT EXISTS idx_screens_pairing_code_hash ON screens(pairing_code_hash);
CREATE INDEX IF NOT EXISTS idx_screens_mtls_fingerprint ON screens(mtls_fingerprint);
