import { randomBytes } from 'node:crypto';
import { pool } from './db.js';
import { hashPassword } from './lib/auth.js';

const email = (process.argv[2] || process.env.ADMIN_EMAIL || '').trim().toLowerCase();
if (!email) {
  console.error('usage: npm run seed:admin -- <email> [password]');
  process.exit(1);
}
const password = process.argv[3] || randomBytes(12).toString('base64url');
const hash = await hashPassword(password);

await pool.query(
  `INSERT INTO admin_users (email, password_hash) VALUES ($1, $2)
   ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash`,
  [email, hash],
);
console.log(`admin ready: ${email}`);
if (!process.argv[3]) console.log(`generated password: ${password}`);
await pool.end();
