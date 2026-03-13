-- =============================================================================
-- migrations/005_groups_and_roles.sql  (revised)
-- Works with actual schema — memberships, notifications, user_group_map exist.
-- All statements are idempotent (IF NOT EXISTS / DO NOTHING).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 0. ltree already enabled — verify
-- -----------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS ltree;

-- -----------------------------------------------------------------------------
-- 1. groups — infinite nesting via ltree path
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS groups (
  id          BIGSERIAL    PRIMARY KEY,
  org_id      UUID         NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  parent_id   BIGINT       REFERENCES groups(id) ON DELETE CASCADE,
  name        TEXT         NOT NULL,
  path        ltree        NOT NULL,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT groups_path_unique UNIQUE (path)
);

CREATE INDEX IF NOT EXISTS idx_groups_path_gist ON groups USING GIST (path);
CREATE INDEX IF NOT EXISTS idx_groups_org_id    ON groups (org_id);
CREATE INDEX IF NOT EXISTS idx_groups_parent_id ON groups (parent_id);

-- -----------------------------------------------------------------------------
-- 2. Seed one root group per organization
-- -----------------------------------------------------------------------------
INSERT INTO groups (org_id, parent_id, name, path)
SELECT
  o.id,
  NULL,
  o.name,
  text2ltree(regexp_replace(lower(regexp_replace(o.slug, '[^a-zA-Z0-9_]', '_', 'g')), '_+', '_', 'g'))
FROM organizations o
ON CONFLICT (path) DO NOTHING;

-- Migrate existing device_groups as child groups under their org root
INSERT INTO groups (org_id, parent_id, name, path)
SELECT
  dg.org_id,
  g.id,
  dg.name,
  g.path || text2ltree(
    regexp_replace(
      lower(regexp_replace(dg.name, '[^a-zA-Z0-9 _]', '', 'g')),
      '[ _]+', '_', 'g'
    ) || '_' || dg.id::text
  )
FROM device_groups dg
JOIN groups g ON g.org_id = dg.org_id AND g.parent_id IS NULL
WHERE dg.org_id IS NOT NULL
ON CONFLICT (path) DO NOTHING;

-- -----------------------------------------------------------------------------
-- 3. Add group_id to screens
-- -----------------------------------------------------------------------------
ALTER TABLE screens ADD COLUMN IF NOT EXISTS group_id BIGINT REFERENCES groups(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_screens_group_id ON screens (group_id);

-- Migrate screens from device_group_members into new group_id
UPDATE screens s
SET group_id = g.id
FROM device_group_members dgm
JOIN device_groups dg ON dg.id = dgm.group_id
JOIN groups g ON g.name = dg.name AND g.org_id = dg.org_id
WHERE dgm.device_id = s.id
  AND s.group_id IS NULL;

-- -----------------------------------------------------------------------------
-- 4. Extend users for role system + reviewer->publisher link
--    users already has: id, email, password_hash, name, role, preferences,
--                       created_at, org_id
-- -----------------------------------------------------------------------------
ALTER TABLE users ADD COLUMN IF NOT EXISTS group_id       BIGINT REFERENCES groups(id) ON DELETE SET NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS parent_user_id BIGINT REFERENCES users(id)  ON DELETE SET NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Migrate roles to owner/publisher/reviewer
UPDATE users SET role = CASE
  WHEN role IN ('admin', 'superadmin', 'owner')           THEN 'owner'
  WHEN role IN ('manager', 'publisher', 'editor')         THEN 'publisher'
  WHEN role IN ('viewer', 'reviewer', 'readonly', 'user') THEN 'reviewer'
  ELSE 'publisher'
END
WHERE role NOT IN ('owner', 'publisher', 'reviewer');

CREATE INDEX IF NOT EXISTS idx_users_group_id       ON users (group_id);
CREATE INDEX IF NOT EXISTS idx_users_parent_user_id ON users (parent_user_id);

-- -----------------------------------------------------------------------------
-- 5. user_group_map already exists (id uuid, user_id uuid, group_id uuid)
--    Add reference to new groups table
-- -----------------------------------------------------------------------------
ALTER TABLE user_group_map ADD COLUMN IF NOT EXISTS new_group_id BIGINT REFERENCES groups(id) ON DELETE CASCADE;

-- -----------------------------------------------------------------------------
-- 6. notifications already exists — add missing columns our system needs
--    Existing: id, user_id, type, level, title, message, device_id,
--              created_at, is_read
-- -----------------------------------------------------------------------------
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS payload JSONB        NOT NULL DEFAULT '{}';
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS emailed BOOLEAN      NOT NULL DEFAULT false;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS org_id  UUID         REFERENCES organizations(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_notifications_user_unread
  ON notifications (user_id, is_read, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_org_id
  ON notifications (org_id);

-- -----------------------------------------------------------------------------
-- 7. publish_approvals
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS publish_approvals (
  id               BIGSERIAL    PRIMARY KEY,
  org_id           UUID         NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  reviewer_id      UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  publisher_id     UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  payload          JSONB        NOT NULL,
  summary          TEXT,
  status           TEXT         NOT NULL DEFAULT 'pending'
                                CHECK (status IN ('pending', 'approved', 'rejected')),
  rejection_reason TEXT,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  resolved_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_approvals_publisher_id ON publish_approvals (publisher_id, status);
CREATE INDEX IF NOT EXISTS idx_approvals_reviewer_id  ON publish_approvals (reviewer_id);
CREATE INDEX IF NOT EXISTS idx_approvals_org_id       ON publish_approvals (org_id);

-- -----------------------------------------------------------------------------
-- 8. Add org_id to remaining core tables
-- -----------------------------------------------------------------------------
ALTER TABLE content_schedules ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES organizations(id);
UPDATE content_schedules
  SET org_id = '00000000-0000-0000-0000-000000000001' WHERE org_id IS NULL;

ALTER TABLE publish_jobs ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES organizations(id);
UPDATE publish_jobs
  SET org_id = '00000000-0000-0000-0000-000000000001' WHERE org_id IS NULL;

ALTER TABLE proof_of_play ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES organizations(id);
UPDATE proof_of_play
  SET org_id = '00000000-0000-0000-0000-000000000001' WHERE org_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_content_schedules_org_id ON content_schedules (org_id);
CREATE INDEX IF NOT EXISTS idx_publish_jobs_org_id      ON publish_jobs (org_id);
CREATE INDEX IF NOT EXISTS idx_proof_of_play_org_id     ON proof_of_play (org_id);

-- -----------------------------------------------------------------------------
-- 9. organizations — add missing columns
-- -----------------------------------------------------------------------------
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS settings   JSONB       NOT NULL DEFAULT '{}';
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS owner_id   UUID        REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

UPDATE organizations o
SET owner_id = (
  SELECT id FROM users u
  WHERE u.org_id = o.id AND u.role = 'owner'
  ORDER BY u.created_at ASC LIMIT 1
)
WHERE o.owner_id IS NULL;

-- =============================================================================
-- Done.
-- CREATED:  groups, publish_approvals
-- MODIFIED: screens, users, notifications, user_group_map, organizations
--           content_schedules, publish_jobs, proof_of_play
-- SEEDED:   groups from organizations + device_groups
-- ROLES:    admin->owner  manager->publisher  viewer->reviewer
-- =============================================================================
