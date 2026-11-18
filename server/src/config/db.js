import mysql from 'mysql2/promise';
import { env } from './env.js';

// Pool unique. Toutes les requetes sont parametrees (placeholders ?).
export const pool = mysql.createPool({
  host: env.DB_HOST,
  port: env.DB_PORT,
  user: env.DB_USER,
  password: env.DB_PASSWORD,
  database: env.DB_NAME,
  ssl: env.dbSsl,
  waitForConnections: true,
  connectionLimit: Number(process.env.DB_POOL_SIZE ?? 15), // 12 entreprises en parallèle : 15 connexions suffisent largement
  queueLimit: 200, // au-delà, on refuse proprement au lieu d'empiler indéfiniment
  connectTimeout: 10_000,
  enableKeepAlive: true,
  timezone: 'Z', // dates stockees en UTC
  decimalNumbers: false, // DECIMAL renvoye en chaine : jamais de flottant pour l'argent
  charset: 'utf8mb4',
});

// Session en UTC : coherence des TIMESTAMP quel que soit le fuseau du serveur MySQL.
// READ COMMITTED : chaque requête d'une transaction voit les données DÉJÀ VALIDÉES par les autres transactions.
// Sous REPEATABLE READ (défaut MySQL), un recalcul (ex. somme des règlements d'une facture) lu après un verrou
// utilisait un instantané PÉRIMÉ et écrasait le résultat d'une transaction concurrente (règlements simultanés
// acceptés au-delà du solde). Les accès concurrents sont sérialisés par des verrous explicites (SELECT … FOR UPDATE).
// sql_mode : MySQL 8 et TiDB activent ONLY_FULL_GROUP_BY par défaut, contrairement à MariaDB/XAMPP où le code a été écrit et testé.
// Plusieurs rapports (ex. préparation TEJ) regroupent par identifiant de facture et lisent des colonnes jointes en relation 1-1 : ils
// échouaient en « Erreur interne » sur TiDB. On aligne la session sur le comportement testé en retirant ce seul drapeau.
pool.on('connection', (conn) => {
  conn.query("SET SESSION sql_mode = REPLACE(REPLACE(@@sql_mode, 'ONLY_FULL_GROUP_BY,', ''), 'ONLY_FULL_GROUP_BY', '')");
  conn.query("SET time_zone = '+00:00'");
  conn.query('SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED');
});

export async function pingDb() {
  const [rows] = await pool.query('SELECT 1 AS ok');
  return rows[0].ok === 1;
}

// Transaction helper : commit si le callback reussit, rollback sinon.
export async function withTransaction(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}
