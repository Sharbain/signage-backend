const { Pool } = require('pg');
const pool = new Pool({ connectionString: 'postgresql://signage_user:Ss0cWtizd833b4u0Onrve0jXvrYeNtMC@dpg-d6ao8g248b3s73betfrg-a.oregon-postgres.render.com/signage_4hkk', ssl: { rejectUnauthorized: false } });
pool.query('SELECT * FROM organizations').then(r => { console.log(JSON.stringify(r.rows, null, 2)); process.exit(0); }).catch(e => { console.error(e.message); process.exit(1); });
