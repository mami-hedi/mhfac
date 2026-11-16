// Sauvegarde logique de la base (mysqldump, cohérente : --single-transaction) compressée en .sql.gz,
// avec purge des anciennes sauvegardes. Aucun mot de passe sur la ligne de commande (variable MYSQL_PWD du processus enfant).
//   npm run backup                 -> backups/mhfac_AAAAMMJJ_HHMMSS.sql.gz
// Variables : DB_* (obligatoires), BACKUP_DIR (défaut ./backups), BACKUP_RETENTION_DAYS (défaut 14), MYSQLDUMP_PATH (défaut "mysqldump").
// Restauration : voir docs/DEPLOIEMENT.md (npm run restore -- <fichier.sql.gz>).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';

const need = (k) => { if (!process.env[k]) { console.error(`Variable manquante : ${k}`); process.exit(1); } return process.env[k]; };
const dir = path.resolve(process.env.BACKUP_DIR ?? 'backups');
const keepDays = Number(process.env.BACKUP_RETENTION_DAYS ?? 14);
fs.mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '_').slice(0, 15);
const file = path.join(dir, `${need('DB_NAME')}_${stamp}.sql.gz`);

const child = spawn(process.env.MYSQLDUMP_PATH ?? 'mysqldump', [
  `--host=${need('DB_HOST')}`, `--port=${process.env.DB_PORT ?? 3306}`, `--user=${need('DB_USER')}`,
  '--single-transaction', '--routines', '--triggers', '--default-character-set=utf8mb4', process.env.DB_NAME,
], { env: { ...process.env, MYSQL_PWD: process.env.DB_PASSWORD ?? '' }, stdio: ['ignore', 'pipe', 'pipe'] });
let err = '';
child.stderr.on('data', (d) => { err += d; });
const exited = new Promise((res, rej) => { child.on('error', rej); child.on('close', res); });
try {
  await pipeline(child.stdout, zlib.createGzip(), fs.createWriteStream(file));
  const code = await exited;
  if (code !== 0) throw new Error(err.trim() || `mysqldump a échoué (code ${code})`);
} catch (e) {
  fs.rmSync(file, { force: true });
  console.error(`Sauvegarde ÉCHOUÉE : ${e.code === 'ENOENT' ? 'mysqldump introuvable (ajoutez-le au PATH ou définissez MYSQLDUMP_PATH)' : e.message}`);
  process.exit(1);
}
const size = fs.statSync(file).size;
if (size < 200) { fs.rmSync(file, { force: true }); console.error('Sauvegarde ÉCHOUÉE : fichier vide.'); process.exit(1); }
console.log(`Sauvegarde OK : ${file} (${(size / 1024).toFixed(0)} Ko)`);
const limit = Date.now() - keepDays * 86400000;
for (const f of fs.readdirSync(dir)) {
  const p = path.join(dir, f);
  if (/^.+_\d{8}_\d{6}\.sql\.gz$/.test(f) && f.startsWith(process.env.DB_NAME) && fs.statSync(p).mtimeMs < limit) { fs.rmSync(p); console.log(`Purgée (> ${keepDays} j) : ${f}`); }
}
