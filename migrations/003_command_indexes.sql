CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_device_commands_device_sent
  ON device_commands (device_id, sent)
  WHERE sent = false;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_screens_api_key_hash
  ON screens (api_key_hash)
  WHERE api_key_hash IS NOT NULL;
