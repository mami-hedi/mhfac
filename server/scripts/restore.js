// Restaure une sauvegarde .sql.gz dans la base DB_NAME. DESTRUCTIF : remplace les tables existantes de la sauvegarde.
//   npm run restore -- backups/mhfac_20261101_120000.sql.gz --yes
// Sans --yes, le script refuse (confirmation explicite obligatoire). Arrêtez l'API avant de restaurer.
// Variables : DB_*, MYSQL_PATH (défaut "mysql").
import fs from 'node:fs';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
if (!file || !fs.existsSync(file)) { console.error('Usage : npm run restore -- <fichier.sql.gz> --yes'); process.exit(1); }
if (!args.includes('--yes')) { console.error(`Restauration vers la base « ${process.env.DB_NAME} » : opération destructive. Relancez avec --yes pour confirmer (et arrêtez l'API).`); process.exit(1); }
const child = spawn(process.env.MYSQL_PATH ?? 'mysql', [
  `--host=${process.env.DB_HOST}`, `--port=${process.env.DB_PORT ?? 3306}`, `--user=${process.env.DB_USER}`, '--default-character-set=utf8mb4', process.env.DB_NAME,
], { env: { ...process.env, MYSQL_PWD: process.env.DB_PASSWORD ?? '' }, stdio: ['pipe', 'inherit', 'pipe'] });
let err = '';
child.stderr.on('data', (d) => { err += d; });
const exited = new Promise((res, rej) => { child.on('error', rej); child.on('close', res); });
try {
  await pipeline(fs.createReadStream(file), zlib.createGunzip(), child.stdin);
  const code = await exited;
  if (code !== 0) throw new Error(err.trim() || `mysql a échoué (code ${code})`);
  console.log(`Restauration OK depuis ${file}`);
} catch (e) {
  console.error(`Restauration ÉCHOUÉE : ${e.code === 'ENOENT' ? 'client mysql introuvable (PATH ou MYSQL_PATH)' : e.message}`);
  process.exit(1);
}
