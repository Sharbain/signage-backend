-- migrations/001_add_indexes.sql
-- Safe performance indexes (run manually with psql or your DB console).
-- These are non-destructive and can be applied anytime.

CREATE INDEX IF NOT EXISTS idx_screens_group_id ON screens(group_id);
CREATE INDEX IF NOT EXISTS idx_screens_last_seen ON screens(last_seen);
CREATE INDEX IF NOT EXISTS idx_screens_is_online ON screens(is_online);

CREATE INDEX IF NOT EXISTS idx_device_commands_device_status_created
  ON device_commands(device_id, status, created_at);

CREATE INDEX IF NOT EXISTS idx_device_status_logs_device_created
  ON device_status_logs(device_id, created_at);

-- Add more indexes as you confirm query patterns.
