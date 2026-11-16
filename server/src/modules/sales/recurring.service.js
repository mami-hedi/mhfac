// Factures récurrentes : un modèle (lignes + conditions) génère des factures BROUILLON à chaque échéance.
// Rien n'est émis ni envoyé automatiquement : une personne relit puis émet. Idempotence : (modèle, période) est unique.
import { pool, withTransaction } from '../../config/db.js';
import { audit } from '../../core/audit.js';
import { HttpError } from '../../utils/httpError.js';
import { insertInvoiceDraft } from './invoices.service.js';
import { todayTunis } from './common.js';

const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
const MAX_CATCH_UP = 12; // périodes rattrapées par exécution (sécurité)

// Date suivante en conservant le jour de départ (31 janvier -> 28 février -> 31 mars).
export function nextDate(iso, frequency, startIso) {
  const [y, m, d] = iso.split('-').map(Number);
  if (frequency === 'weekly') { const t = new Date(Date.UTC(y, m - 1, d + 7)); return t.toISOString().slice(0, 10); }
  const step = { monthly: 1, quarterly: 3, yearly: 12 }[frequency];
  const startDay = Number(startIso.split('-')[2]);
  const total = (y * 12 + (m - 1)) + step; const ny = Math.floor(total / 12); const nm = total % 12;
  const last = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  return `${ny}-${String(nm + 1).padStart(2, '0')}-${String(Math.min(startDay, last)).padStart(2, '0')}`;
}

// Génère les brouillons dus pour un modèle (verrouillé). Retourne les numéros de périodes générées.
async function runTemplate(conn, row, today, ip) {
  const generated = [];
  let next = String(row.next_date); let status = row.status; let count = row.run_count;
  const tpl = parse(row.template);
  const [[client]] = await conn.query('SELECT public_id FROM clients WHERE id = ?', [row.client_id]);
  while (status === 'active' && next && next <= today && generated.length < MAX_CATCH_UP) {
    const [[done]] = await conn.query('SELECT invoice_id FROM recurring_runs WHERE recurring_id = ? AND period_date = ?', [row.id, next]);
    if (!done) {
      const body = { ...tpl, clientId: client.public_id, issueDate: today };
      const inv = await insertInvoiceDraft(conn, { companyId: row.company_id, userId: row.created_by }, body, { recurring_id: row.id }, { ip, meta: { recurring: row.name, period: next } });
      await conn.query('INSERT INTO recurring_runs (recurring_id, period_date, invoice_id) VALUES (?,?,?)', [row.id, next, inv.id]);
      generated.push({ period: next, invoiceId: inv.publicId });
      count += 1;
    }
    next = nextDate(next, row.frequency, row.start_date_s);
    if (row.end_date_s && next > row.end_date_s) { status = 'ended'; next = null; }
  }
  if (generated.length || status !== row.status || next !== row.next_date) {
    await conn.query('UPDATE recurring_invoices SET next_run_date = ?, status = ?, run_count = ?, last_run_at = IF(?, UTC_TIMESTAMP(), last_run_at) WHERE id = ?', [next, status, count, generated.length > 0, row.id]);
  }
  return generated;
}

// companyId = null : toutes les entreprises (planificateur). Chaque modèle est traité dans sa propre transaction.
export async function runDue({ companyId = null, recurringId = null, ip = null } = {}) {
  const today = todayTunis();
  const [due] = await pool.query(
    `SELECT id FROM recurring_invoices WHERE status = 'active' AND next_run_date <= ? ${companyId ? 'AND company_id = ?' : ''} ${recurringId ? 'AND id = ?' : ''} ORDER BY id LIMIT 500`,
    [today, ...(companyId ? [companyId] : []), ...(recurringId ? [recurringId] : [])]);
  const result = { generated: 0, failed: [] };
  for (const { id } of due) {
    try {
      await withTransaction(async (conn) => {
        const [[row]] = await conn.query("SELECT r.*, DATE_FORMAT(r.next_run_date,'%Y-%m-%d') AS next_date, DATE_FORMAT(r.start_date,'%Y-%m-%d') AS start_date_s, DATE_FORMAT(r.end_date,'%Y-%m-%d') AS end_date_s FROM recurring_invoices r WHERE r.id = ? AND r.status = 'active' FOR UPDATE", [id]);
        if (!row || !row.next_date || row.next_date > today) return; // déjà traité par une autre instance
        const g = await runTemplate(conn, row, today, ip);
        result.generated += g.length;
        if (g.length) await audit(conn, { companyId: row.company_id, userId: row.created_by, action: 'recurring.run', entityType: 'recurring_invoices', entityId: row.public_id, ip, meta: { count: g.length, periods: g.map((x) => x.period) } });
      });
    } catch (e) {
      result.failed.push({ id, message: e instanceof HttpError ? e.message : 'Erreur de génération' });
      if (!(e instanceof HttpError)) console.error('[recurring]', e.message);
    }
  }
  return result;
}

export function startRecurringScheduler(intervalMs = 3_600_000) {
  const tick = () => runDue().then((r) => { if (r.generated || r.failed.length) console.log(`[recurring] ${r.generated} brouillon(s) généré(s), ${r.failed.length} échec(s)`); }).catch((e) => console.error('[recurring]', e.message));
  const first = setTimeout(tick, 15_000); const timer = setInterval(tick, intervalMs);
  first.unref(); timer.unref();
  return () => { clearTimeout(first); clearInterval(timer); };
}
