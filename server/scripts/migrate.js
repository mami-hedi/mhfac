// Runner de migrations SQL versionnees : migrations/NNN_nom.sql, appliquees dans l'ordre, une seule fois.
// Usage : npm run migrate | npm run migrate:status
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';
import { env } from '../src/config/env.js';
import { syncRolesAndPermissions } from '../src/core/permissions.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const command = process.argv[2] ?? 'up';

const base = {
  host: env.DB_HOST, port: env.DB_PORT, user: env.DB_USER, password: env.DB_PASSWORD,
  multipleStatements: true, charset: 'utf8mb4', ssl: env.dbSsl,
};

async function main() {
  // Cree la base si l'utilisateur en a le droit ; sinon elle doit exister deja.
  const admin = await mysql.createConnection(base);
  try {
    await admin.query(`CREATE DATABASE IF NOT EXISTS \`${env.DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  } catch (e) {
    console.warn(`(base non creee automatiquement : ${e.message})`);
  }
  await admin.end();

  const conn = await mysql.createConnection({ ...base, database: env.DB_NAME });
  await conn.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name VARCHAR(190) NOT NULL PRIMARY KEY,
    applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  const [rows] = await conn.query('SELECT name FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.name));
  const files = (await readdir(dir)).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();

  if (command === 'status') {
    for (const f of files) console.log(`${applied.has(f) ? '[x]' : '[ ]'} ${f}`);
    await conn.end();
    return;
  }

  let count = 0;
  for (const f of files) {
    if (applied.has(f)) continue;
    console.log(`> ${f}`);
    await conn.query(await readFile(path.join(dir, f), 'utf8'));
    await conn.query('INSERT INTO schema_migrations (name) VALUES (?)', [f]);
    count++;
  }
  console.log(count ? `${count} migration(s) appliquee(s).` : 'Base a jour.');
  // Donnees de reference (roles, permissions) : synchronisees a chaque migration, idempotent.
  await syncRolesAndPermissions(conn);
  console.log('Roles et permissions synchronises.');
  await conn.end();
}

main().catch((e) => { console.error(`Echec migration : ${e.message}`); process.exit(1); });
