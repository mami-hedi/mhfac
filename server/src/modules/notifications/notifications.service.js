// Notifications dans l'application. Principes :
//  - destinataires choisis par PERMISSION (donc par rôle) : on prévient ceux qui peuvent agir, pas tout le monde ;
//  - génération idempotente : UNIQUE (entreprise, utilisateur, dedupe_key) + INSERT IGNORE → rejouer l'analyse ne crée aucun doublon ;
//  - les situations qui durent (factures en retard, stock bas) sont regroupées en UNE notification (pas une par facture) ;
//  - aucune donnée n'est inventée : tout vient de la base de l'entreprise concernée ; l'entreprise vient toujours de la session.
import crypto from 'node:crypto';
import { pool } from '../../config/db.js';
import { newPublicId } from '../../core/ids.js';

export const CATEGORIES = { sales: 'Ventes', stock_purchases: 'Stock et achats', subscription: 'Abonnement' };
// perm : permission nécessaire pour recevoir ce type (celle de l'action à mener).
export const TYPES = {
  invoice_overdue:       { category: 'sales', label: 'Factures clients en retard de paiement', perm: 'invoice.write' },
  invoice_due_soon:      { category: 'sales', label: 'Factures clients bientôt échues (3 jours)', perm: 'invoice.write' },
  payment_received:      { category: 'sales', label: 'Encaissement enregistré', perm: 'payment.write' },
  supplier_due:          { category: 'stock_purchases', label: 'Factures fournisseurs à payer', perm: 'purchase.write' },
  low_stock:             { category: 'stock_purchases', label: 'Articles sous le seuil d\'alerte', perm: 'stock.write' },
  negative_stock:        { category: 'stock_purchases', label: 'Stock négatif', perm: 'stock.write' },
  trial_ending:          { category: 'subscription', label: 'Fin de la période d\'essai', perm: 'subscription.read' },
  subscription_expiring: { category: 'subscription', label: 'Abonnement bientôt expiré', perm: 'subscription.read' },
  subscription_expired:  { category: 'subscription', label: 'Abonnement expiré (lecture seule)', perm: 'subscription.read' },
  subscription_payment:  { category: 'subscription', label: 'Paiement d\'abonnement confirmé ou refusé', perm: 'subscription.read' },
};

export const allowedTypes = (permissions) => Object.entries(TYPES).filter(([, t]) => permissions.has(t.perm)).map(([k]) => k);

export async function disabledTypes(companyId, userId, conn = pool) {
  const [rows] = await conn.query('SELECT type FROM notification_preferences WHERE company_id = ? AND user_id = ? AND enabled = 0', [companyId, userId]);
  return rows.map((r) => r.type);
}
// Types visibles pour un utilisateur : ceux que son rôle permet ET qu'il n'a pas désactivés.
export async function visibleTypes(auth, conn = pool) {
  const off = new Set(await disabledTypes(auth.companyId, auth.userId, conn));
  return allowedTypes(auth.permissions).filter((t) => !off.has(t));
}

const tunisToday = (now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Tunis' }).format(now);
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const weekStart = (iso) => { const d = new Date(`${iso}T00:00:00Z`); return addDays(iso, -((d.getUTCDay() + 6) % 7)); };
const dayDiff = (a, b) => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000);
const fmtDate = (iso) => iso.split('-').reverse().join('/');
const plural = (n, one, many) => `${n} ${n > 1 ? many : one}`;
const idsKey = (ids) => crypto.createHash('sha1').update([...ids].sort().join(',')).digest('hex').slice(0, 12);
const money = (v, cur) => `${Number(v).toLocaleString('fr-FR', { minimumFractionDigits: 3, maximumFractionDigits: 3 })} ${cur}`;
const names = (list, max = 4) => `${list.slice(0, max).join(', ')}${list.length > max ? ` et ${list.length - max} autre${list.length - max > 1 ? 's' : ''}` : ''}`;

async function recipients(conn, companyId, perm) {
  const [rows] = await conn.query(
    `SELECT DISTINCT cm.user_id FROM company_members cm JOIN users u ON u.id = cm.user_id
       JOIN role_permissions rp ON rp.role_id = cm.role_id JOIN permissions p ON p.id = rp.permission_id
      WHERE cm.company_id = ? AND cm.status = 'active' AND u.status = 'active' AND p.code = ?`, [companyId, perm]);
  return rows.map((r) => r.user_id);
}

// Crée la notification pour chaque destinataire autorisé ; renvoie le nombre de lignes réellement créées.
export async function notify(conn, companyId, type, { severity = 'info', title, body = null, link = null, dedupeKey }) {
  const def = TYPES[type]; if (!def) throw new Error(`Type de notification inconnu : ${type}`);
  let created = 0;
  for (const userId of await recipients(conn, companyId, def.perm)) {
    const [r] = await conn.query(
      `INSERT IGNORE INTO notifications (public_id, company_id, user_id, type, severity, title, body, link, dedupe_key, created_at)
       VALUES (?,?,?,?,?,?,?,?,?, UTC_TIMESTAMP())`,
      [newPublicId(), companyId, userId, type, severity, title.slice(0, 190), body?.slice(0, 500) ?? null, link, `${type}:${dedupeKey}`.slice(0, 120)]);
    created += r.affectedRows;
  }
  return created;
}

const UNPAID = 'net_payable - paid_amount > 0';

export async function scanCompany(companyId, now = new Date(), conn = pool) {
  const today = tunisToday(now); const soon = addDays(today, 3); let created = 0;
  const go = async (type, n) => { created += await notify(conn, companyId, type, n); };

  // --- Ventes ---
  const [[od]] = await conn.query(`SELECT COUNT(*) n, MIN(due_date) oldest FROM invoices WHERE company_id = ? AND kind = 'invoice' AND status = 'issued' AND due_date < ? AND ${UNPAID}`, [companyId, today]);
  if (od.n > 0) {
    const oldest = new Date(od.oldest).toISOString().slice(0, 10);
    await go('invoice_overdue', { severity: 'critical', title: `${plural(od.n, 'facture client en retard', 'factures clients en retard')} de paiement`, body: `La plus ancienne est échue depuis le ${fmtDate(oldest)} (${dayDiff(today, oldest)} jour${dayDiff(today, oldest) > 1 ? 's' : ''}). Relancez vos clients.`, link: '/sales/reminders', dedupeKey: weekStart(today) });
  }
  const [dueSoon] = await conn.query(`SELECT id FROM invoices WHERE company_id = ? AND kind = 'invoice' AND status = 'issued' AND due_date BETWEEN ? AND ? AND ${UNPAID}`, [companyId, today, soon]);
  if (dueSoon.length) await go('invoice_due_soon', { severity: 'warning', title: `${plural(dueSoon.length, 'facture client arrive', 'factures clients arrivent')} à échéance dans les 3 jours`, body: 'Pensez à prévenir vos clients avant la date limite.', link: '/sales/invoices', dedupeKey: idsKey(dueSoon.map((r) => r.id)) });
  const since = new Date(now.getTime() - 48 * 3600_000);
  const [pays] = await conn.query(`SELECT p.public_id, p.amount, p.currency, p.number, c.name FROM payments p JOIN clients c ON c.id = p.client_id WHERE p.company_id = ? AND p.status = 'recorded' AND p.method <> 'withholding' AND p.created_at >= ? ORDER BY p.id DESC LIMIT 20`, [companyId, since]);
  for (const p of pays) await go('payment_received', { title: `Encaissement de ${money(p.amount, p.currency)}`, body: `${p.name} — règlement ${p.number}.`, link: '/payments', dedupeKey: p.public_id });

  // --- Achats et stock ---
  const [supOver] = await conn.query(`SELECT id FROM purchase_invoices WHERE company_id = ? AND kind = 'invoice' AND status = 'recorded' AND due_date < ? AND ${UNPAID}`, [companyId, today]);
  if (supOver.length) await go('supplier_due', { severity: 'critical', title: `${plural(supOver.length, 'facture fournisseur échue', 'factures fournisseurs échues')} non payée${supOver.length > 1 ? 's' : ''}`, body: 'Vérifiez vos échéances fournisseurs.', link: '/purchases/invoices', dedupeKey: `over:${weekStart(today)}` });
  const [supSoon] = await conn.query(`SELECT id FROM purchase_invoices WHERE company_id = ? AND kind = 'invoice' AND status = 'recorded' AND due_date BETWEEN ? AND ? AND ${UNPAID}`, [companyId, today, soon]);
  if (supSoon.length) await go('supplier_due', { severity: 'warning', title: `${plural(supSoon.length, 'facture fournisseur à payer', 'factures fournisseurs à payer')} dans les 3 jours`, link: '/purchases/invoices', dedupeKey: `soon:${idsKey(supSoon.map((r) => r.id))}` });
  const [stock] = await conn.query(
    `SELECT p.id, p.name, p.stock_alert_threshold thr, COALESCE(SUM(sl.quantity), 0) qty FROM products p LEFT JOIN stock_levels sl ON sl.product_id = p.id
      WHERE p.company_id = ? AND p.status = 'active' AND p.track_stock = 1 GROUP BY p.id, p.name, p.stock_alert_threshold`, [companyId]);
  const neg = stock.filter((s) => Number(s.qty) < 0); const low = stock.filter((s) => s.thr != null && Number(s.qty) >= 0 && Number(s.qty) <= Number(s.thr));
  const month = today.slice(0, 7);
  if (neg.length) await go('negative_stock', { severity: 'critical', title: `${plural(neg.length, 'article a', 'articles ont')} un stock négatif`, body: names(neg.map((s) => s.name)), link: '/stock/inventory', dedupeKey: `${idsKey(neg.map((s) => s.id))}:${month}` });
  if (low.length) await go('low_stock', { severity: 'warning', title: `${plural(low.length, 'article est', 'articles sont')} sous le seuil d'alerte`, body: names(low.map((s) => s.name)), link: '/stock/inventory', dedupeKey: `${idsKey(low.map((s) => s.id))}:${month}` });

  // --- Abonnement ---
  const [[sub]] = await conn.query('SELECT status, trial_ends_at, current_period_end FROM company_subscriptions WHERE company_id = ?', [companyId]);
  if (sub) {
    const iso = (d) => new Date(d).toISOString().slice(0, 10);
    if (sub.status === 'trial' && sub.trial_ends_at) {
      const end = iso(sub.trial_ends_at); const left = dayDiff(end, today);
      if (left < 0) await go('subscription_expired', { severity: 'critical', title: 'Votre période d\'essai est terminée', body: 'L\'application est en lecture seule. Passez au paiement pour tout réactiver.', link: '/subscription/pay', dedupeKey: `trial:${end}` });
      else if (left <= 3) await go('trial_ending', { severity: left <= 1 ? 'critical' : 'warning', title: left === 0 ? 'Votre essai gratuit se termine aujourd\'hui' : `Votre essai gratuit se termine dans ${plural(left, 'jour', 'jours')}`, body: `Fin le ${fmtDate(end)}. Passez au paiement pour continuer sans interruption.`, link: '/subscription/pay', dedupeKey: end });
    } else if ((sub.status === 'active' || sub.status === 'past_due') && sub.current_period_end) {
      const end = iso(sub.current_period_end); const left = dayDiff(end, today);
      if (left < 0) await go('subscription_expired', { severity: 'critical', title: 'Votre abonnement a expiré', body: 'L\'application est en lecture seule. Déclarez votre paiement pour la réactiver.', link: '/subscription/pay', dedupeKey: `period:${end}` });
      else if (left <= 7) await go('subscription_expiring', { severity: left <= 2 ? 'critical' : 'warning', title: `Votre abonnement expire dans ${plural(left, 'jour', 'jours')}`, body: `Fin de période le ${fmtDate(end)}. Pensez à renouveler.`, link: '/subscription/pay', dedupeKey: end });
    }
    const [reviewed] = await conn.query(`SELECT public_id, status, review_note, amount, currency FROM subscription_payments WHERE company_id = ? AND status IN ('confirmed','rejected') AND reviewed_at >= ?`, [companyId, new Date(now.getTime() - 30 * 86400_000)]);
    for (const p of reviewed) {
      await go('subscription_payment', p.status === 'confirmed'
        ? { title: 'Votre paiement d\'abonnement est confirmé', body: `Virement de ${money(p.amount, p.currency)} validé : votre abonnement est actif.`, link: '/subscription', dedupeKey: `${p.public_id}:confirmed` }
        : { severity: 'critical', title: 'Votre déclaration de paiement a été refusée', body: p.review_note ? `Motif : ${p.review_note}` : null, link: '/subscription/pay', dedupeKey: `${p.public_id}:rejected` });
    }
  }
  return created;
}

// Analyse à la demande, limitée à 1 passage / 5 min / entreprise (la cloche interroge toutes les minutes).
const lastScan = new Map(); export const SCAN_INTERVAL_MS = 300_000;
export const resetScanThrottle = () => lastScan.clear();
export async function scanCompanyThrottled(companyId, now = new Date()) {
  const t = lastScan.get(companyId); if (t && now.getTime() - t < SCAN_INTERVAL_MS) return 0;
  lastScan.set(companyId, now.getTime());
  try { return await scanCompany(companyId, now); }
  catch (e) { lastScan.delete(companyId); console.error('[notifications] analyse impossible :', e.message); return 0; }
}

export async function runNotificationScan(now = new Date()) {
  const [companies] = await pool.query("SELECT id FROM companies WHERE status = 'active'");
  let created = 0; const failed = [];
  for (const c of companies) { try { created += await scanCompany(c.id, now); } catch (e) { failed.push({ companyId: c.id, error: e.message }); } }
  await pool.query('DELETE FROM notifications WHERE created_at < ? OR (read_at IS NOT NULL AND read_at < ?)', [new Date(now.getTime() - 180 * 86400_000), new Date(now.getTime() - 60 * 86400_000)]);
  return { created, failed };
}

export function startNotificationScheduler(intervalMs = 3_600_000) {
  const tick = () => runNotificationScan().then((r) => { if (r.created || r.failed.length) console.log(`[notifications] ${r.created} créée(s), ${r.failed.length} échec(s)`); }).catch((e) => console.error('[notifications]', e.message));
  const first = setTimeout(tick, 45_000); const timer = setInterval(tick, intervalMs);
  first.unref(); timer.unref();
  return () => { clearTimeout(first); clearInterval(timer); };
}
