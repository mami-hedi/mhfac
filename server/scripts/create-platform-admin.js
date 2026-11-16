// Crée (ou promeut) un super administrateur de la plateforme.
// Usage : npm run create-admin -- --email admin@exemple.tn --name "Nom Prénom"
// Le mot de passe est lu dans PLATFORM_ADMIN_PASSWORD, sinon demandé à l'écran (jamais passé en argument ni journalisé).
import readline from 'node:readline';
import { pool, withTransaction } from '../src/config/db.js';
import { hashPassword } from '../src/core/password.js';
import { newPublicId } from '../src/core/ids.js';
import { ensureSubscription } from '../src/core/plan.js';

const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined; };
const email = (arg('email') ?? '').trim().toLowerCase(); const name = arg('name') ?? 'Administrateur plateforme';
if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { console.error('Usage : npm run create-admin -- --email admin@exemple.tn --name "Nom Prénom"'); process.exit(1); }

async function askPassword() {
  if (process.env.PLATFORM_ADMIN_PASSWORD) return process.env.PLATFORM_ADMIN_PASSWORD;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  rl._writeToOutput = (s) => { if (s.includes('Mot de passe')) process.stdout.write(s); }; // saisie masquée
  return new Promise((res) => rl.question('Mot de passe (12 caractères min.) : ', (a) => { rl.close(); process.stdout.write('\n'); res(a); }));
}
try {
  const [[existing]] = await pool.query('SELECT id FROM users WHERE email = ?', [email]);
  if (existing) {
    await pool.query('UPDATE users SET is_platform_admin = 1 WHERE id = ?', [existing.id]);
    console.log(`Compte existant promu super administrateur : ${email}`);
  } else {
    const pwd = await askPassword();
    if (pwd.length < 12 || !/[a-z]/.test(pwd) || !/[A-Z]/.test(pwd) || !/\d/.test(pwd)) { console.error('Mot de passe trop faible : 12 caractères minimum avec majuscule, minuscule et chiffre.'); process.exit(1); }
    await withTransaction(async (conn) => {
      const [c] = await conn.query('INSERT INTO companies (public_id, name) VALUES (?,?)', [newPublicId(), 'MHFac — Administration']);
      await conn.query('INSERT INTO company_settings (company_id, settings) VALUES (?, ?)', [c.insertId, '{}']);
      const [u] = await conn.query('INSERT INTO users (public_id, email, password_hash, full_name, is_platform_admin, email_verified_at) VALUES (?,?,?,?,1,UTC_TIMESTAMP())', [newPublicId(), email, await hashPassword(pwd), name]);
      const [[r]] = await conn.query("SELECT id FROM roles WHERE code = 'owner'");
      await conn.query('INSERT INTO company_members (company_id, user_id, role_id) VALUES (?,?,?)', [c.insertId, u.insertId, r.id]);
      await ensureSubscription(conn, c.insertId);
    });
    console.log(`Super administrateur créé : ${email}`);
  }
} finally { await pool.end(); }
