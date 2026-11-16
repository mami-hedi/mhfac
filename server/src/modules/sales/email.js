// Envoi d'un document par e-mail (PDF en pièce jointe) : mêmes droits que la modification du document,
// destinataires validés, plafond horaire par entreprise, journal de chaque tentative (réussie ou non).
import { z } from 'zod';
import { pool } from '../../config/db.js';
import { HttpError } from '../../utils/httpError.js';
import { audit } from '../../core/audit.js';
import { sendMail } from '../../core/mailer.js';
import { getSettings } from '../companies/settings.js';
import { asyncHandler } from '../../middlewares/asyncHandler.js';
import { requirePermission } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import { idParam } from './common.js';

const MAX_PER_HOUR = 50;
const email = z.string().trim().toLowerCase().email('Adresse e-mail invalide').max(190);
export const sendBody = z.object({
  to: z.union([email, z.array(email).min(1).max(5)]).transform((v) => [...new Set(Array.isArray(v) ? v : [v])]),
  subject: z.preprocess((v) => (v === '' ? undefined : v), z.string().trim().max(200).optional()),
  message: z.preprocess((v) => (v === '' ? undefined : v), z.string().trim().max(3000).optional()),
});

const clean = (s) => s.replace(/[\r\n]+/g, ' ');
const fmt = (v, cur) => `${new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 3, maximumFractionDigits: 3 }).format(Number(v)).replace(/[  ]/g, ' ')} ${cur}`;

export function defaultEmail({ label, doc, company }) {
  const subject = `${label} ${doc.number} — ${company}`;
  const lines = [`Bonjour,`, '', `Veuillez trouver ci-joint ${label.toLowerCase().startsWith('a') ? "l'" : 'le '}${label.toLowerCase()} n° ${doc.number} d'un montant de ${fmt(doc.netPayable ?? doc.totalTtc, doc.currency)}.`];
  if (doc.dueDate) lines.push(`Échéance : ${doc.dueDate.slice(8, 10)}/${doc.dueDate.slice(5, 7)}/${doc.dueDate.slice(0, 4)}.`);
  if (doc.validUntil) lines.push(`Valable jusqu'au ${doc.validUntil.slice(8, 10)}/${doc.validUntil.slice(5, 7)}/${doc.validUntil.slice(0, 4)}.`);
  lines.push('', 'Cordialement,', company);
  return { subject, text: lines.join('\n') };
}

// cfg : { type, perm, label ('Devis'|'Facture'|...), entity (table d'audit), fetchDoc(conn, companyId, publicId), render(doc, companyId), assertSendable(doc), afterSent?(conn, doc, auth) }
export function attachEmailRoutes(router, cfg) {
  router.post('/:id/send', requirePermission(`${cfg.perm}.write`), validate({ params: idParam, body: sendBody }), asyncHandler(async (req, res) => {
    const doc = await cfg.fetchDoc(pool, req.auth.companyId, req.params.id);
    cfg.assertSendable(doc);
    // Anti-abus : un compte dont l'adresse n'est pas confirmée ne peut pas envoyer d'e-mails depuis notre serveur (inscription ouverte à tous).
    const [[sender]] = await pool.query('SELECT email_verified_at FROM users WHERE id = ?', [req.auth.userId]);
    if (!sender?.email_verified_at) throw new HttpError(403, 'EMAIL_NOT_VERIFIED', "Confirmez d'abord votre adresse e-mail (lien reçu à l'inscription) pour envoyer des documents");
    const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM document_emails WHERE company_id = ? AND created_at > (UTC_TIMESTAMP() - INTERVAL 1 HOUR)', [req.auth.companyId]);
    if (n >= MAX_PER_HOUR) throw new HttpError(429, 'MAIL_RATE_LIMIT', `Limite de ${MAX_PER_HOUR} e-mails par heure atteinte`);
    const [[co]] = await pool.query('SELECT name FROM companies WHERE id = ?', [req.auth.companyId]);
    const settings = await getSettings(req.auth.companyId);
    const dflt = defaultEmail({ label: cfg.label, doc, company: co.name });
    const subject = clean(req.body.subject ?? dflt.subject);
    const text = req.body.message ? `${req.body.message}\n\n--\n${co.name}` : dflt.text;
    const pdf = await cfg.render(doc, req.auth.companyId);
    let status = 'sent'; let error = null;
    try {
      await sendMail({ to: req.body.to.join(', '), subject, text, replyTo: settings.identity.email || undefined, attachments: [{ filename: `${doc.number}.pdf`, content: pdf, contentType: 'application/pdf' }] });
    } catch (e) { status = 'failed'; error = String(e.message ?? e).slice(0, 250); }
    await pool.query('INSERT INTO document_emails (company_id, doc_type, doc_public_id, doc_number, recipients, subject, status, error, sent_by) VALUES (?,?,?,?,?,?,?,?,?)',
      [req.auth.companyId, cfg.type, doc.id, doc.number, req.body.to.join(', ').slice(0, 500), subject.slice(0, 200), status, error, req.auth.userId]);
    await audit(null, { companyId: req.auth.companyId, userId: req.auth.userId, action: `${cfg.type}.email`, entityType: cfg.entity, entityId: doc.id, ip: req.ip, meta: { to: req.body.to, status } });
    if (status === 'failed') throw new HttpError(502, 'MAIL_FAILED', 'Envoi impossible : vérifiez la configuration e-mail (SMTP) du serveur');
    if (cfg.afterSent) await cfg.afterSent(doc, req.auth, req.ip);
    res.json({ data: { sent: true, to: req.body.to, subject, doc: await cfg.fetchDoc(pool, req.auth.companyId, req.params.id) } });
  }));

  router.get('/:id/emails', requirePermission(`${cfg.perm}.read`), validate({ params: idParam }), asyncHandler(async (req, res) => {
    const doc = await cfg.fetchDoc(pool, req.auth.companyId, req.params.id);
    const [rows] = await pool.query('SELECT e.recipients, e.subject, e.status, e.error, e.created_at, u.full_name FROM document_emails e LEFT JOIN users u ON u.id = e.sent_by WHERE e.company_id = ? AND e.doc_type = ? AND e.doc_public_id = ? ORDER BY e.id DESC LIMIT 50', [req.auth.companyId, cfg.type, doc.id]);
    res.json({ data: rows.map((r) => ({ to: r.recipients, subject: r.subject, status: r.status, error: r.error, at: r.created_at, by: r.full_name })) });
  }));
}
