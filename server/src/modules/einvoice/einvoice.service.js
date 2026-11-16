// ElectronicInvoiceService + ElectronicInvoiceStatusService : orchestration, machine d'états, historique d'événements, idempotence et reprises.
import { pool, withTransaction } from '../../config/db.js';
import { HttpError } from '../../utils/httpError.js';
import { newPublicId } from '../../core/ids.js';
import { audit } from '../../core/audit.js';
import { PROVIDERS, SimulationFormatAdapter, SimulatedSignatureAdapter, TransientProviderError, ProviderNotConfiguredError, canonical, sha256 } from './adapters.js';

export const STATUS_LABELS = { preparing: 'En préparation', pending: 'En attente de transmission', transmitted: 'Transmise', accepted: 'Acceptée', rejected: 'Rejetée', error: 'En erreur', retry: 'À réessayer' };
const TRANSITIONS = { preparing: ['pending', 'error'], pending: ['transmitted', 'accepted', 'rejected', 'retry', 'error'], retry: ['transmitted', 'accepted', 'rejected', 'retry', 'error'], error: ['transmitted', 'accepted', 'rejected', 'retry', 'error'], transmitted: ['accepted', 'rejected', 'error'], accepted: [], rejected: [] };
export const SUBMITTABLE = ['pending', 'retry', 'error'];
export const MAX_AUTO_ATTEMPTS = 5; const BACKOFF_MIN = [1, 5, 15, 60, 240];
const TIMEOUT_MS = Number(process.env.EINVOICE_TIMEOUT_MS ?? 10000);
const format = new SimulationFormatAdapter(); const signer = new SimulatedSignatureAdapter();

export async function getConfig(conn, companyId) {
  const [[c]] = await conn.query('SELECT provider, scenario FROM einvoice_config WHERE company_id = ?', [companyId]);
  return c ?? { provider: 'simulation', scenario: 'accept' };
}

// Machine d'états : toute transition passe ici ; elle est validée puis journalisée.
export async function transition(conn, tx, to, event, detail, userId, extra = {}) {
  if (tx.status !== to && !TRANSITIONS[tx.status]?.includes(to)) throw new HttpError(409, 'INVALID_TRANSITION', `Transition ${tx.status} → ${to} impossible`);
  const sets = ['status = ?']; const vals = [to];
  for (const [k, v] of Object.entries(extra)) { sets.push(`${k} = ?`); vals.push(v); }
  await conn.query(`UPDATE einvoice_transmissions SET ${sets.join(', ')} WHERE id = ?`, [...vals, tx.id]);
  await conn.query('INSERT INTO einvoice_events (transmission_id, event, from_status, to_status, detail, created_by) VALUES (?,?,?,?,?,?)', [tx.id, event, tx.status, to, detail ? JSON.stringify(detail) : null, userId ?? null]);
  tx.status = to; return tx;
}

export async function loadInvoice(conn, companyId, publicId, forUpdate = false) {
  const [[inv]] = await conn.query(`SELECT i.*, DATE_FORMAT(i.issue_date,'%Y-%m-%d') AS issue_date_s, DATE_FORMAT(i.due_date,'%Y-%m-%d') AS due_date_s FROM invoices i WHERE i.company_id = ? AND i.public_id = ? ${forUpdate ? 'FOR UPDATE' : ''}`, [companyId, publicId]);
  if (!inv) throw new HttpError(404, 'NOT_FOUND', 'Facture introuvable');
  return inv;
}

// Prépare le document (format + signature) et crée la transmission. Idempotent : une facture n'a qu'une transmission.
export async function prepare(auth, ip, invoicePublicId) {
  let created = false; let txId;
  await withTransaction(async (conn) => {
    const inv = await loadInvoice(conn, auth.companyId, invoicePublicId, true);
    if (inv.status !== 'issued') throw new HttpError(422, 'NOT_ISSUED', 'Seule une facture ou un avoir émis peut être préparé pour la facturation électronique');
    const [[ex]] = await conn.query('SELECT id FROM einvoice_transmissions WHERE company_id = ? AND invoice_id = ?', [auth.companyId, inv.id]);
    if (ex) { txId = ex.id; return; }
    const [lines] = await conn.query('SELECT * FROM invoice_lines WHERE invoice_id = ? ORDER BY position', [inv.id]); const [taxes] = await conn.query('SELECT * FROM invoice_tax_lines WHERE invoice_id = ? ORDER BY tax_rate', [inv.id]);
    const cfg = await getConfig(conn, auth.companyId);
    const payload = await format.build({ invoice: inv, lines, taxes }); const text = canonical(payload); const hash = sha256(text); const key = sha256(`${auth.companyId}:${inv.id}:${hash}`);
    const publicId = newPublicId();
    const [r] = await conn.query(`INSERT INTO einvoice_transmissions (public_id, company_id, invoice_id, status, provider, mode, format, idempotency_key, payload_hash, payload, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [publicId, auth.companyId, inv.id, 'preparing', cfg.provider, PROVIDERS[cfg.provider]?.mode ?? 'simulation', format.format, key, hash, text, auth.userId]);
    txId = r.insertId; created = true;
    const tx = { id: txId, status: 'preparing' }; await conn.query('INSERT INTO einvoice_events (transmission_id, event, to_status, detail, created_by) VALUES (?,?,?,?,?)', [txId, 'created', 'preparing', JSON.stringify({ format: format.format, hash }), auth.userId]);
    const sig = await signer.sign(text);
    await transition(conn, tx, 'pending', 'prepared', { signature: sig.status, note: 'Document prêt ; signature simulée (aucune valeur légale)' }, auth.userId, { signature_status: sig.status, signature: sig.signature });
    await audit(conn, { companyId: auth.companyId, userId: auth.userId, action: 'einvoice.prepare', entityType: 'invoices', entityId: invoicePublicId, ip, meta: { number: inv.number, mode: 'simulation' } });
  });
  return { id: txId, created };
}

const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new TransientProviderError(`Délai d'attente dépassé (${ms} ms)`)), ms))]);

// Soumission / nouvelle tentative : verrouille la transmission, appelle le fournisseur avec la MÊME clé d'idempotence, enregistre le résultat.
export async function submit(auth, ip, txPublicId, { event = 'submit' } = {}) {
  let result;
  await withTransaction(async (conn) => {
    const [[tx]] = await conn.query('SELECT * FROM einvoice_transmissions WHERE company_id = ? AND public_id = ? FOR UPDATE', [auth.companyId, txPublicId]);
    if (!tx) throw new HttpError(404, 'NOT_FOUND', 'Transmission introuvable');
    if (!SUBMITTABLE.includes(tx.status)) throw new HttpError(409, 'INVALID_TRANSITION', `Une transmission « ${STATUS_LABELS[tx.status]} » ne peut pas être soumise`);
    const cfg = await getConfig(conn, auth.companyId); const provider = PROVIDERS[tx.provider] ?? PROVIDERS.simulation; const attempts = tx.attempts + 1; const now = new Date();
    try {
      const out = await withTimeout(provider.submit({ idempotencyKey: tx.idempotency_key, payload: tx.payload, scenario: cfg.scenario }), TIMEOUT_MS);
      const to = out.outcome === 'accepted' ? 'accepted' : out.outcome === 'rejected' ? 'rejected' : 'transmitted';
      await conn.query('INSERT INTO einvoice_events (transmission_id, event, from_status, to_status, detail, created_by) VALUES (?,?,?,?,?,?)', [tx.id, event === 'retry' ? 'retry_sent' : 'sent', tx.status, 'transmitted', JSON.stringify({ attempt: attempts, reference: out.reference, idempotencyKey: tx.idempotency_key.slice(0, 12) }), auth.userId]);
      await transition(conn, { ...tx, status: 'transmitted' }, to, `response_${to}`, out.response, auth.userId, { attempts, provider_reference: out.reference, transmitted_at: now, responded_at: to === 'transmitted' ? null : now, response: JSON.stringify(out.response), last_error: to === 'rejected' ? (out.response?.message ?? 'Rejeté') : null, next_retry_at: null });
      result = { status: to };
    } catch (e) {
      const transient = e instanceof TransientProviderError; const configErr = e instanceof ProviderNotConfiguredError;
      if (!transient && !configErr && !(e?.name === 'TransientProviderError')) throw e;
      const exhausted = attempts >= MAX_AUTO_ATTEMPTS || configErr; const to = exhausted ? 'error' : 'retry';
      const next = exhausted ? null : new Date(now.getTime() + BACKOFF_MIN[Math.min(attempts - 1, BACKOFF_MIN.length - 1)] * 60000);
      await transition(conn, tx, to, 'failed', { attempt: attempts, error: String(e.message).slice(0, 300), transient }, auth.userId, { attempts, last_error: String(e.message).slice(0, 500), next_retry_at: next });
      result = { status: to, error: e.message };
    }
    await audit(conn, { companyId: auth.companyId, userId: auth.userId, action: `einvoice.${event}`, entityType: 'einvoice_transmissions', entityId: txPublicId, ip, meta: { status: result.status, attempt: attempts } });
  });
  return result;
}

// Interroge le fournisseur pour une transmission « Transmise » (accusé asynchrone).
export async function refresh(auth, ip, txPublicId) {
  let result;
  await withTransaction(async (conn) => {
    const [[tx]] = await conn.query('SELECT * FROM einvoice_transmissions WHERE company_id = ? AND public_id = ? FOR UPDATE', [auth.companyId, txPublicId]);
    if (!tx) throw new HttpError(404, 'NOT_FOUND', 'Transmission introuvable');
    if (tx.status !== 'transmitted') throw new HttpError(409, 'INVALID_TRANSITION', 'Seule une transmission « Transmise » peut être actualisée');
    const out = await PROVIDERS[tx.provider].getStatus({ reference: tx.provider_reference });
    const to = out.outcome === 'accepted' ? 'accepted' : out.outcome === 'rejected' ? 'rejected' : 'transmitted';
    if (to !== tx.status) await transition(conn, tx, to, `response_${to}`, out.response, auth.userId, { responded_at: new Date(), response: JSON.stringify(out.response) });
    result = { status: to };
  });
  return result;
}

// Relance toutes les transmissions « À réessayer » dont l'échéance est passée (à appeler depuis une tâche planifiée / un cron).
export async function retryDue(auth, ip) {
  const [rows] = await pool.query("SELECT public_id FROM einvoice_transmissions WHERE company_id = ? AND status = 'retry' AND next_retry_at <= UTC_TIMESTAMP() ORDER BY next_retry_at LIMIT 50", [auth.companyId]);
  const out = [];
  for (const r of rows) { try { out.push({ id: r.public_id, ...(await submit(auth, ip, r.public_id, { event: 'retry' })) }); } catch (e) { out.push({ id: r.public_id, status: 'skipped', error: e.message }); } }
  return out;
}
