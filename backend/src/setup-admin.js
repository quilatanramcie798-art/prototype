import bcrypt from "bcryptjs";
import "dotenv/config";
import { query, pool } from "./db.js";

const [email, password] = process.argv.slice(2);
if (!email || !password) {
  console.error("Usage: npm run setup-admin -- admin@example.com strong-password");
  process.exit(1);
}
const hash = await bcrypt.hash(password, 12);
await query("INSERT INTO users (email, password_hash, role) VALUES ($1, $2, 'admin') ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = 'admin'", [email, hash]);
console.log(`Admin account ready: ${email}`);
await pool.end();
