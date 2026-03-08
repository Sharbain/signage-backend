-- migrations/004_multi_tenant.sql
-- Adds multi-tenancy: organizations table + org_id on core tables
-- Existing data is assigned to a default "Lumina" organization

-- 1. Create organizations table
CREATE TABLE IF NOT EXISTS organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  plan TEXT NOT NULL DEFAULT 'starter',
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- 2. Insert default org for existing data
INSERT INTO organizations (id, name, slug, plan)
VALUES ('00000000-0000-0000-0000-000000000001', 'Lumina', 'lumina', 'enterprise')
ON CONFLICT (slug) DO NOTHING;

-- 3. Add org_id to users
ALTER TABLE users ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES organizations(id);
UPDATE users SET org_id = '00000000-0000-0000-0000-000000000001' WHERE org_id IS NULL;

-- 4. Add org_id to screens
ALTER TABLE screens ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES organizations(id);
UPDATE screens SET org_id = '00000000-0000-0000-0000-000000000001' WHERE org_id IS NULL;

-- 5. Add org_id to media
ALTER TABLE media ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES organizations(id);
UPDATE media SET org_id = '00000000-0000-0000-0000-000000000001' WHERE org_id IS NULL;

-- 6. Add org_id to content_playlists
ALTER TABLE content_playlists ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES organizations(id);
UPDATE content_playlists SET org_id = '00000000-0000-0000-0000-000000000001' WHERE org_id IS NULL;

-- 7. Add org_id to device_groups
ALTER TABLE device_groups ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES organizations(id);
UPDATE device_groups SET org_id = '00000000-0000-0000-0000-000000000001' WHERE org_id IS NULL;

-- 8. Add org_id to clients
ALTER TABLE clients ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES organizations(id);
UPDATE clients SET org_id = '00000000-0000-0000-0000-000000000001' WHERE org_id IS NULL;

-- 9. Indexes for fast org filtering
CREATE INDEX IF NOT EXISTS idx_users_org_id ON users(org_id);
CREATE INDEX IF NOT EXISTS idx_screens_org_id ON screens(org_id);
CREATE INDEX IF NOT EXISTS idx_media_org_id ON media(org_id);
CREATE INDEX IF NOT EXISTS idx_content_playlists_org_id ON content_playlists(org_id);
CREATE INDEX IF NOT EXISTS idx_device_groups_org_id ON device_groups(org_id);
CREATE INDEX IF NOT EXISTS idx_clients_org_id ON clients(org_id);
