// Relances clients : liste des factures émises en retard (échéance dépassée, solde > 0) regroupées par client,
// envoi d'un e-mail de relance (sans pièce jointe) et journal de chaque tentative. Montants lus en base, jamais fournis par le client.
import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../../config/db.js';
import { HttpError } from '../../utils/httpError.js';
import { audit } from '../../core/audit.js';
import { sendMail } from '../../core/mailer.js';
import { addMoney } from '../../core/calc.js';
import { getSettings } from '../companies/settings.js';
import { asyncHandler } from '../../middlewares/asyncHandler.js';
import { authenticate, requirePermission } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import { todayTunis } from '../sales/common.js';

const router = Router();
router.use(authenticate);
const BAL = "(d.net_payable - d.paid_amount - (SELECT COALESCE(SUM(cn.net_payable),0) FROM invoices cn WHERE cn.credited_invoice_id = d.id AND cn.kind = 'credit_note' AND cn.status = 'issued'))";
const fmt = (v, cur) => `${new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 3, maximumFractionDigits: 3 }).format(Number(v)).replace(/[  ]/g, ' ')} ${cur}`;
const frDate = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const clean = (s) => s.replace(/[\r\n]+/g, ' ');
const MIN_DELAY_H = 24;

async function overdueRows(companyId, clientPublicId) {
  const [rows] = await pool.query(
    `SELECT d.public_id, d.number, d.currency, DATE_FORMAT(d.due_date,'%Y-%m-%d') AS due, DATEDIFF(?, d.due_date) AS days_late, ${BAL} AS balance,
            c.id AS client_id, c.public_id AS client_pid, c.name AS client_name, c.email AS client_email
       FROM invoices d JOIN clients c ON c.id = d.client_id
      WHERE d.company_id = ? AND d.kind = 'invoice' AND d.status = 'issued' AND d.due_date < ? AND ${BAL} > 0 ${clientPublicId ? 'AND c.public_id = ?' : ''}
      ORDER BY c.name, d.due_date`, [todayTunis(), companyId, todayTunis(), ...(clientPublicId ? [clientPublicId] : [])]);
  return rows;
}

router.get('/overdue', requirePermission('payment.read'), asyncHandler(async (req, res) => {
  const rows = await overdueRows(req.auth.companyId);
  const [last] = await pool.query(`SELECT r.client_id, MAX(r.created_at) AS at, COUNT(*) AS n FROM payment_reminders r WHERE r.company_id = ? AND r.status = 'sent' GROUP BY r.client_id`, [req.auth.companyId]);
  const lastBy = new Map(last.map((l) => [Number(l.client_id), l]));
  const groups = new Map();
  for (const r of rows) {
    const g = groups.get(r.client_pid) ?? { client: { id: r.client_pid, name: r.client_name, email: r.client_email }, invoices: [], totals: {}, maxDaysLate: 0, lastReminderAt: lastBy.get(Number(r.client_id))?.at ?? null, reminderCount: Number(lastBy.get(Number(r.client_id))?.n ?? 0) };
    g.invoices.push({ id: r.public_id, number: r.number, dueDate: r.due, daysLate: Number(r.days_late), balance: r.balance, currency: r.currency });
    g.totals[r.currency] = addMoney(g.totals[r.currency] ?? '0.000', r.balance); g.maxDaysLate = Math.max(g.maxDaysLate, Number(r.days_late));
    groups.set(r.client_pid, g);
  }
  res.json({ data: [...groups.values()].sort((a, b) => b.maxDaysLate - a.maxDaysLate), meta: { clients: groups.size } });
}));

const email = z.string().trim().toLowerCase().email('Adresse e-mail invalide').max(190);
const sendBody = z.object({
  clientId: z.string().uuid(),
  to: z.union([email, z.array(email).min(1).max(5)]).transform((v) => [...new Set(Array.isArray(v) ? v : [v])]),
  subject: z.preprocess((v) => (v === '' ? undefined : v), z.string().trim().max(200).optional()),
  message: z.preprocess((v) => (v === '' ? undefined : v), z.string().trim().max(3000).optional()),
  force: z.boolean().optional(),
});

router.post('/send', requirePermission('payment.write'), validate({ body: sendBody }), asyncHandler(async (req, res) => {
  const b = req.body; const rows = await overdueRows(req.auth.companyId, b.clientId);
  if (!rows.length) throw new HttpError(409, 'NOTHING_OVERDUE', "Ce client n'a aucune facture en retard");
  const clientDbId = rows[0].client_id;
  if (!b.force) {
    const [[r]] = await pool.query(`SELECT COUNT(*) AS n FROM payment_reminders WHERE company_id = ? AND client_id = ? AND status = 'sent' AND created_at > (UTC_TIMESTAMP() - INTERVAL ${MIN_DELAY_H} HOUR)`, [req.auth.companyId, clientDbId]);
    if (r.n > 0) throw new HttpError(409, 'RECENT_REMINDER', `Une relance a déjà été envoyée à ce client depuis moins de ${MIN_DELAY_H} h`);
  }
  const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM payment_reminders WHERE company_id = ? AND created_at > (UTC_TIMESTAMP() - INTERVAL 1 HOUR)', [req.auth.companyId]);
  if (n >= 50) throw new HttpError(429, 'MAIL_RATE_LIMIT', 'Limite de 50 relances par heure atteinte');
  const [[co]] = await pool.query('SELECT name FROM companies WHERE id = ?', [req.auth.companyId]);
  const settings = await getSettings(req.auth.companyId);
  const currencies = [...new Set(rows.map((r) => r.currency))];
  const totals = currencies.map((cur) => [cur, rows.filter((r) => r.currency === cur).reduce((s, r) => addMoney(s, r.balance), '0.000')]);
  const subject = clean(b.subject ?? `Rappel de paiement — ${co.name}`);
  const list = rows.map((r) => `- Facture ${r.number} — échue le ${frDate(r.due)} (${r.days_late} j de retard) — solde ${fmt(r.balance, r.currency)}`);
  const intro = b.message ?? `Bonjour,\n\nSauf erreur ou omission de notre part, les factures suivantes restent impayées à ce jour :`;
  const text = [intro, '', ...(b.message ? ['Factures concernées :'] : []), ...list, '', `Total dû : ${totals.map(([c, t]) => fmt(t, c)).join(' + ')}`, '', 'Si vous avez déjà effectué ce règlement, merci de ne pas tenir compte de ce message.', '', 'Cordialement,', co.name].join('\n');
  let status = 'sent'; let error = null;
  try { await sendMail({ to: b.to.join(', '), subject, text, replyTo: settings.identity.email || undefined }); } catch (e) { status = 'failed'; error = String(e.message ?? e).slice(0, 250); }
  await pool.query('INSERT INTO payment_reminders (company_id, client_id, recipients, subject, invoice_numbers, total_due, currency, status, error, sent_by) VALUES (?,?,?,?,?,?,?,?,?,?)',
    [req.auth.companyId, clientDbId, b.to.join(', ').slice(0, 500), subject.slice(0, 200), rows.map((r) => r.number).join(', ').slice(0, 1000), totals[0][1], totals[0][0], status, error, req.auth.userId]);
  await audit(null, { companyId: req.auth.companyId, userId: req.auth.userId, action: 'payment_reminder.send', entityType: 'clients', entityId: b.clientId, ip: req.ip, meta: { to: b.to, status, invoices: rows.length } });
  if (status === 'failed') throw new HttpError(502, 'MAIL_FAILED', 'Envoi impossible : vérifiez la configuration e-mail (SMTP) du serveur');
  res.json({ data: { sent: true, to: b.to, subject, invoices: rows.length } });
}));

router.get('/history', requirePermission('payment.read'), validate({ query: z.object({ clientId: z.string().uuid().optional() }) }), asyncHandler(async (req, res) => {
  const [rows] = await pool.query(`SELECT r.recipients, r.subject, r.invoice_numbers, r.total_due, r.currency, r.status, r.error, r.created_at, c.name AS client_name, c.public_id AS client_pid, u.full_name
      FROM payment_reminders r JOIN clients c ON c.id = r.client_id LEFT JOIN users u ON u.id = r.sent_by
     WHERE r.company_id = ? ${req.query.clientId ? 'AND c.public_id = ?' : ''} ORDER BY r.id DESC LIMIT 100`, [req.auth.companyId, ...(req.query.clientId ? [req.query.clientId] : [])]);
  res.json({ data: rows.map((r) => ({ client: { id: r.client_pid, name: r.client_name }, to: r.recipients, subject: r.subject, invoices: r.invoice_numbers, total: r.total_due, currency: r.currency, status: r.status, error: r.error, at: r.created_at, by: r.full_name })) });
}));

export default router;
