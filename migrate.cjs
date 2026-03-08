const { Pool } = require('pg');
const pool = new Pool({ connectionString: 'postgresql://signage_user:Ss0cWtizd833b4u0Onrve0jXvrYeNtMC@dpg-d6ao8g248b3s73betfrg-a.oregon-postgres.render.com/signage_4hkk', ssl: { rejectUnauthorized: false } });
const ORG_ID = '541737fc-bb73-4684-83d9-b077cac47e38';
const sql = `
ALTER TABLE users ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES organizations(id);
UPDATE users SET org_id = '${ORG_ID}' WHERE org_id IS NULL;

ALTER TABLE screens ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES organizations(id);
UPDATE screens SET org_id = '${ORG_ID}' WHERE org_id IS NULL;

ALTER TABLE media ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES organizations(id);
UPDATE media SET org_id = '${ORG_ID}' WHERE org_id IS NULL;

ALTER TABLE content_playlists ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES organizations(id);
UPDATE content_playlists SET org_id = '${ORG_ID}' WHERE org_id IS NULL;

ALTER TABLE device_groups ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES organizations(id);
UPDATE device_groups SET org_id = '${ORG_ID}' WHERE org_id IS NULL;

ALTER TABLE clients ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES organizations(id);
UPDATE clients SET org_id = '${ORG_ID}' WHERE org_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_users_org_id ON users(org_id);
CREATE INDEX IF NOT EXISTS idx_screens_org_id ON screens(org_id);
CREATE INDEX IF NOT EXISTS idx_media_org_id ON media(org_id);
CREATE INDEX IF NOT EXISTS idx_content_playlists_org_id ON content_playlists(org_id);
CREATE INDEX IF NOT EXISTS idx_device_groups_org_id ON device_groups(org_id);
CREATE INDEX IF NOT EXISTS idx_clients_org_id ON clients(org_id);
`;
pool.query(sql).then(() => { console.log('Done!'); process.exit(0); }).catch(e => { console.error(e.message); process.exit(1); });
