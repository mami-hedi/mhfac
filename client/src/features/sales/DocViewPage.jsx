import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Ban, CheckCircle2, ClipboardList, Percent, Receipt, Truck, Copy, Download, FileMinus, History, Pencil, Mail, Send, Trash2, Wallet, XCircle, ArrowRightLeft } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { api, errorMessage } from '../../services/api.js';
import { Alert, Button, Card, Modal, PageHeader, Spinner } from '../../components/ui/index.jsx';
import { downloadCsv } from '../masterdata/shared.jsx';
import { INVOICE_TYPE, StatusBadge, fmtDate, fmtMoney } from './shared.jsx';
import { CFG } from './DocListPage.jsx';
import PaymentModal, { METHOD_LABELS } from '../payments/PaymentModal.jsx';
import WithholdingModal, { CancelWithholdingModal } from '../payments/WithholdingModal.jsx';
import { DeliveryModal, DepositModal, OrderPanels } from './OrderParts.jsx';

const ACTION_LABELS = { 'sales_order.create': 'Création', 'sales_order.update': 'Modification', 'sales_order.confirm': 'Confirmée', 'sales_order.cancel': 'Annulée', 'sales_order.send': 'Envoyée par e-mail', 'delivery.create': 'Création', 'delivery.update': 'Modification', 'delivery.validate': 'Validé', 'delivery.cancel': 'Annulé', 'delivery.send': 'Envoyé par e-mail', 'quote.create': 'Création', 'quote.update': 'Modification', 'quote.sent': 'Marqué envoyé', 'quote.accepted': 'Marqué accepté', 'quote.refused': 'Marqué refusé', 'quote.draft': 'Remis en brouillon', 'quote.convert': 'Converti en facture', 'quote.duplicate': 'Dupliqué', 'invoice.create': 'Création', 'invoice.update': 'Modification', 'invoice.issue': 'Émission', 'invoice.cancel': 'Annulation', 'invoice.payment': 'Règlement enregistré', 'quote.email': 'Envoyé par e-mail', 'invoice.email': 'Envoyée par e-mail', 'credit_note.email': 'Envoyé par e-mail', 'credit_note.create': 'Création', 'credit_note.issue': 'Émission' };

function CreditModal({ invoice, onClose, onDone }) {
  const [reason, setReason] = useState('');
  const [qty, setQty] = useState(() => Object.fromEntries(invoice.lines.map((l) => [l.id, Number(l.creditableQuantity) > 0 ? String(Number(l.creditableQuantity)) : '0'])));
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true); setError('');
    const lines = invoice.lines.filter((l) => Number(qty[l.id]) > 0).map((l) => ({ invoiceLineId: l.id, quantity: qty[l.id] }));
    if (!lines.length) { setError('Indiquez au moins une quantité à créditer.'); setBusy(false); return; }
    try { onDone((await api.post('/credit-notes', { invoiceId: invoice.id, reason, lines })).data.data); } catch (e) { setError(errorMessage(e)); setBusy(false); }
  };
  return (
    <Modal title={`Créer un avoir pour ${invoice.number}`} onClose={onClose} size="lg">
      <div className="space-y-4">
        <Alert tone="error">{error}</Alert>
        <div><label htmlFor="reason" className="mb-1 block text-sm font-medium">Motif *</label><input id="reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={255} className="block w-full rounded-md border border-slate-300 px-3 py-2 text-sm" placeholder="Ex. retour de marchandise, erreur de prix…" /></div>
        <table className="w-full text-sm"><thead className="text-left text-xs uppercase text-slate-500"><tr><th className="py-2">Ligne</th><th className="py-2 text-right">Reste créditable</th><th className="py-2 text-right">Qté à créditer</th></tr></thead>
          <tbody className="divide-y divide-slate-100">{invoice.lines.map((l) => (
            <tr key={l.id}><td className="py-2">{l.description}</td><td className="py-2 text-right tabular-nums">{Number(l.creditableQuantity)}</td>
              <td className="py-2 text-right"><input aria-label={`Quantité à créditer ligne ${l.position}`} disabled={Number(l.creditableQuantity) <= 0} value={qty[l.id]} onChange={(e) => setQty({ ...qty, [l.id]: e.target.value })} inputMode="decimal" className="w-24 rounded-md border border-slate-300 px-2 py-1 text-right text-sm" /></td></tr>))}</tbody></table>
        <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Annuler</Button><Button loading={busy} disabled={reason.trim().length < 3} onClick={submit}>Créer le brouillon d'avoir</Button></div>
      </div>
    </Modal>
  );
}

export function EmailModal({ doc, cfg, onClose, onDone }) {
  const [to, setTo] = useState(doc.client.email ?? ''); const [subject, setSubject] = useState(''); const [message, setMessage] = useState('');
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const submit = async () => {
    const list = to.split(/[;,\s]+/).filter(Boolean);
    if (!list.length) { setError('Saisissez au moins un destinataire.'); return; }
    setBusy(true); setError('');
    try { await api.post(`${cfg.api}/${doc.id}/send`, { to: list, subject: subject || undefined, message: message || undefined }); onDone(list); } catch (e) { setError(errorMessage(e)); setBusy(false); }
  };
  return (
    <Modal title={`Envoyer ${doc.number} par e-mail`} onClose={onClose} size="lg">
      <div className="space-y-4">
        <Alert tone="error">{error}</Alert>
        <div><label htmlFor="mail-to" className="mb-1 block text-sm font-medium">Destinataire(s) * <span className="font-normal text-slate-500">(5 maximum, séparés par une virgule)</span></label><input id="mail-to" value={to} onChange={(e) => setTo(e.target.value)} className="block w-full rounded-md border border-slate-300 px-3 py-2 text-sm" /></div>
        <div><label htmlFor="mail-subject" className="mb-1 block text-sm font-medium">Objet</label><input id="mail-subject" value={subject} maxLength={200} placeholder={`${cfg.one[0].toUpperCase()}${cfg.one.slice(1)} ${doc.number}`} onChange={(e) => setSubject(e.target.value)} className="block w-full rounded-md border border-slate-300 px-3 py-2 text-sm" /></div>
        <div><label htmlFor="mail-msg" className="mb-1 block text-sm font-medium">Message</label><textarea id="mail-msg" rows={4} value={message} maxLength={3000} placeholder="Laissez vide pour le message standard" onChange={(e) => setMessage(e.target.value)} className="block w-full rounded-md border border-slate-300 px-3 py-2 text-sm" /></div>
        <p className="text-xs text-slate-500">Le PDF du document est joint. Les réponses vont à l'adresse e-mail de votre entreprise (Paramètres).</p>
        <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Annuler</Button><Button loading={busy} onClick={submit}><Mail size={16} aria-hidden /> Envoyer</Button></div>
      </div>
    </Modal>
  );
}

export default function DocViewPage({ kind }) {
  const cfg = CFG[kind]; const { id } = useParams(); const navigate = useNavigate(); const { can } = useAuth();
  const [doc, setDoc] = useState(null); const [error, setError] = useState('');
  const [notice, setNotice] = useState({ tone: 'success', text: '' });
  const [busy, setBusy] = useState(''); const [modal, setModal] = useState(null); const [cancelReason, setCancelReason] = useState('');
  const [hist, setHist] = useState(null);

  const load = useCallback(async () => {
    try { setDoc((await api.get(`${cfg.api}/${id}`)).data.data); setHist(null); } catch (e) { setError(errorMessage(e)); }
  }, [cfg.api, id]);
  useEffect(() => { load(); }, [load]);

  const run = async (key, fn, ok) => {
    setBusy(key); setNotice({ tone: 'success', text: '' });
    try { const r = await fn(); if (ok) setNotice({ tone: 'success', text: ok }); await load(); return r; } catch (e) { setNotice({ tone: 'error', text: errorMessage(e) }); } finally { setBusy(''); }
    return null;
  };

  if (error) return <Alert tone="error">{error}</Alert>;
  if (!doc) return <Spinner />;
  const P = cfg.perm; const draft = doc.status === 'draft'; const cur = doc.currency;
  const title = doc.number ?? `${cfg.one[0].toUpperCase()}${cfg.one.slice(1)} (brouillon)`;
  const btn = (icon, label, fn, { variant = 'secondary', key = label, ok, disabled } = {}) => <Button variant={variant} disabled={disabled} loading={busy === key} onClick={() => run(key, fn, ok)}>{icon} {label}</Button>;
  const setStatus = (s, ok) => btn(null, ok.label, () => api.post(`${cfg.api}/${id}/status`, { status: s }), { key: s, ok: ok.text, variant: ok.variant });

  const actions = [];
  actions.push(<Button key="pdf" variant="secondary" onClick={() => downloadCsv(`${cfg.api}/${id}/pdf`, undefined, `${doc.number ?? 'brouillon'}.pdf`).catch((e) => setNotice({ tone: 'error', text: errorMessage(e) }))}><Download size={16} aria-hidden /> PDF</Button>);
  if (kind === 'quote') {
    const editable = ['draft', 'sent'].includes(doc.storedStatus ?? doc.status);
    if (can('quote.write')) {
      if (editable) actions.push(<Button key="edit" variant="secondary" onClick={() => navigate(`${cfg.base}/${id}/edit`)}><Pencil size={16} aria-hidden /> Modifier</Button>);
      if (doc.storedStatus === 'draft') actions.push(<span key="send">{btn(<Send size={16} aria-hidden />, 'Marquer envoyé', () => api.post(`${cfg.api}/${id}/status`, { status: 'sent' }), { key: 'sent', ok: 'Devis marqué comme envoyé' })}</span>);
      if (doc.storedStatus === 'sent') {
        actions.push(<span key="acc">{btn(<CheckCircle2 size={16} aria-hidden />, 'Accepté', () => api.post(`${cfg.api}/${id}/status`, { status: 'accepted' }), { key: 'accepted', ok: 'Devis accepté' })}</span>);
        actions.push(<span key="ref">{btn(<XCircle size={16} aria-hidden />, 'Refusé', () => api.post(`${cfg.api}/${id}/status`, { status: 'refused' }), { key: 'refused', ok: 'Devis refusé' })}</span>);
      }
      actions.push(<span key="dup">{btn(<Copy size={16} aria-hidden />, 'Dupliquer', async () => { const r = await api.post(`${cfg.api}/${id}/duplicate`); navigate(`${cfg.base}/${r.data.data.id}`); }, { key: 'dup' })}</span>);
    }
    if (doc.storedStatus === 'accepted' && can('quote.validate') && can('sales_order.write')) actions.push(<span key="ord">{btn(<ClipboardList size={16} aria-hidden />, 'Créer une commande', async () => { const r = await api.post(`/orders/from-quote/${id}`); navigate(`/sales/orders/${r.data.data.id}`); }, { key: 'ord' })}</span>);
    if (doc.storedStatus === 'accepted' && can('quote.validate') && can('invoice.write')) actions.push(<span key="conv">{btn(<ArrowRightLeft size={16} aria-hidden />, 'Convertir en facture', async () => { const r = await api.post(`${cfg.api}/${id}/convert`); navigate(`/sales/invoices/${r.data.data.invoiceId}`); }, { key: 'conv', variant: 'primary' })}</span>);
  } else if (kind === 'sales_order') {
    if (draft && can('sales_order.write')) actions.push(<Button key="edit" variant="secondary" onClick={() => navigate(`${cfg.base}/${id}/edit`)}><Pencil size={16} aria-hidden /> Modifier</Button>);
    if (draft && can('sales_order.validate')) actions.push(<span key="confirm">{btn(<CheckCircle2 size={16} aria-hidden />, 'Confirmer la commande', () => api.post(`${cfg.api}/${id}/confirm`), { key: 'confirm', variant: 'primary', ok: 'Commande confirmée : le contenu est verrouillé' })}</span>);
    if (doc.status === 'confirmed') {
      if (can('delivery.write') && doc.lines.some((l) => Number(l.deliverableQuantity) > 0)) actions.push(<Button key="bl" variant="primary" onClick={() => setModal('delivery')}><Truck size={16} aria-hidden /> Créer un bon de livraison</Button>);
      if (can('sales_order.validate') && can('invoice.write')) {
        const noBl = doc.invoicingStatus !== 'partial' && doc.invoicingStatus !== 'invoiced';
        if (noBl) actions.push(<span key="inv">{btn(<Receipt size={16} aria-hidden />, doc.invoices.some((i) => i.type === 'deposit' && i.status !== 'cancelled') ? 'Créer la facture de solde' : 'Créer la facture', async () => { const r = await api.post(`${cfg.api}/${id}/invoice`); navigate(`/sales/invoices/${r.data.data.invoiceId}`); }, { key: 'inv', disabled: doc.invoicingStatus === 'invoiced' })}</span>);
        if (noBl) actions.push(<Button key="dep" variant="secondary" onClick={() => setModal('deposit')}><Percent size={16} aria-hidden /> Facture d'acompte</Button>);
      }
      if (can('sales_order.validate')) actions.push(<Button key="cancel" variant="secondary" onClick={() => setModal('cancel')}><Ban size={16} aria-hidden /> Annuler</Button>);
    }
    if (draft && can('sales_order.validate')) actions.push(<Button key="cancel" variant="secondary" onClick={() => setModal('cancel')}><Ban size={16} aria-hidden /> Annuler</Button>);
  } else if (draft) {
    if (kind === 'invoice' && can('invoice.write')) actions.push(<Button key="edit" variant="secondary" onClick={() => navigate(`${cfg.base}/${id}/edit`)}><Pencil size={16} aria-hidden /> Modifier</Button>);
    if (can(`${P}.validate`)) actions.push(<span key="issue">{btn(<CheckCircle2 size={16} aria-hidden />, 'Valider et émettre', () => api.post(`${cfg.api}/${id}/issue`), { key: 'issue', variant: 'primary', ok: 'Document émis : numéro attribué, contenu figé' })}</span>);
  } else if (kind === 'invoice' && doc.status === 'issued') {
    if (can('payment.write') && Number(doc.balance) > 0) actions.push(<Button key="pay" variant="primary" onClick={() => setModal('pay')}><Wallet size={16} aria-hidden /> Enregistrer un règlement</Button>);
    if (can('payment.write') && Number(doc.balance) > 0 && !(Number(doc.withholdingAmount) > 0) && !doc.addedWithholding) actions.push(<Button key="rs" variant="secondary" onClick={() => setModal('rs')}>Enregistrer une retenue à la source</Button>);
    if (can('payment.validate') && doc.addedWithholding) actions.push(<Button key="rs-cancel" variant="secondary" onClick={() => setModal('rs-cancel')}>Annuler la retenue ajoutée</Button>);
    if (doc.logistics?.canGenerateDeliveryNote && can('delivery.write')) actions.push(<Button key="gbl" variant="secondary" loading={busy === 'gbl'} onClick={() => run('gbl', async () => { const r = await api.post(`${cfg.api}/${id}/delivery-note`, {}); navigate(`/sales/delivery-notes/${r.data.data.deliveryNoteId}`); return r; })}><Truck size={16} aria-hidden /> Générer un Bon de Livraison (BL)</Button>);
    if (can('credit_note.write')) actions.push(<Button key="cn" variant="secondary" onClick={() => setModal('credit')}><FileMinus size={16} aria-hidden /> Créer un avoir</Button>);
    if (can('invoice.validate')) actions.push(<Button key="cancel" variant="secondary" onClick={() => setModal('cancel')}><Ban size={16} aria-hidden /> Annuler</Button>);
  }
  const sendable = kind === 'quote' ? !['expired', 'converted'].includes(doc.status) : kind === 'sales_order' ? doc.status === 'confirmed' : doc.status === 'issued';
  if (sendable && can(`${P}.write`)) actions.splice(1, 0, <Button key="mail" variant="secondary" onClick={() => setModal('mail')}><Mail size={16} aria-hidden /> Envoyer</Button>);
  const deletable = (kind === 'quote' ? doc.storedStatus === 'draft' : draft) && can(`${P}.delete`);
  if (deletable) actions.push(<Button key="del" variant="ghost" onClick={() => setModal('delete')}><Trash2 size={16} className="text-red-600" aria-hidden /> Supprimer</Button>);

  return (
    <>
      <PageHeader title={title} subtitle={<span className="inline-flex flex-wrap items-center gap-2"><StatusBadge kind={kind} doc={doc} /><span>{doc.client.name}</span></span>} actions={<div className="flex flex-wrap gap-2">{actions}</div>} />
      <div className="mb-4 space-y-3">
        <Alert tone={notice.tone} onClose={() => setNotice({ tone: 'success', text: '' })}>{notice.text}</Alert>
        {kind === 'quote' && doc.status === 'converted' && doc.convertedInvoice && <Alert tone="info">Converti en facture <Link className="font-medium underline" to={`/sales/invoices/${doc.convertedInvoice.id}`}>brouillon / n° {doc.convertedInvoice.number ?? 'à émettre'}</Link>. Les montants de ce devis sont verrouillés.</Alert>}
        {kind === 'sales_order' && doc.quote && <Alert tone="info">Issue du devis <Link className="font-medium underline" to={`/sales/quotes/${doc.quote.id}`}>{doc.quote.number}</Link>.</Alert>}
        {kind === 'sales_order' && doc.status === 'cancelled' && <Alert tone="error">Commande annulée — motif : {doc.cancelReason}.</Alert>}
        {kind === 'invoice' && INVOICE_TYPE[doc.invoiceType] && <Alert tone="info">{INVOICE_TYPE[doc.invoiceType]}{doc.invoiceType === 'deposit' ? ` (${Number(doc.depositPct)} % de la commande) : sera déduite de la facture de solde.` : ' : les acomptes déjà facturés sont déduits du net à payer.'}</Alert>}
        {kind === 'invoice' && doc.order && <Alert tone="info">Commande <Link className="font-medium underline" to={`/sales/orders/${doc.order.id}`}>{doc.order.number}</Link>{doc.deliveryNote && <> · bon de livraison <Link className="font-medium underline" to={`/sales/delivery-notes/${doc.deliveryNote.id}`}>{doc.deliveryNote.number}</Link></>}.</Alert>}
        {kind === 'invoice' && doc.stockExit && <Alert tone="info">{doc.status === 'draft' ? 'À l\'émission, les articles suivis en stock sortiront du stock' : doc.status === 'issued' ? `Articles sortis du stock par cette facture (${doc.stockMovements ?? 0} ligne(s))` : 'Sortie de stock annulée avec la facture'}{doc.warehouse ? ` — entrepôt ${doc.warehouse.name}` : ''}.</Alert>}
        {kind === 'invoice' && doc.deliveryNotes?.some((n) => n.status !== 'cancelled') && <Alert tone="info">Bon de livraison lié : {doc.deliveryNotes.filter((n) => n.status !== 'cancelled').map((n) => <Link key={n.id} className="font-medium underline" to={`/sales/delivery-notes/${n.id}`}>{n.number ?? 'brouillon'} ({n.status === 'draft' ? 'brouillon' : 'validé'}{n.stockImpact ? '' : ', sans second mouvement de stock'})</Link>)}.</Alert>}
        {kind === 'invoice' && doc.recurring && <Alert tone="info">Générée par la facture récurrente « {doc.recurring.name} ». Relisez-la puis émettez-la : rien n'est envoyé automatiquement.</Alert>}
        {kind === 'invoice' && doc.quote && <Alert tone="info">Issue du devis <Link className="font-medium underline" to={`/sales/quotes/${doc.quote.id}`}>{doc.quote.number}</Link>.</Alert>}
        {kind === 'credit_note' && doc.creditedInvoice && <Alert tone="info">Avoir sur la facture <Link className="font-medium underline" to={`/sales/invoices/${doc.creditedInvoice.id}`}>{doc.creditedInvoice.number}</Link> — motif : {doc.creditReason}</Alert>}
        {kind === 'invoice' && doc.status === 'cancelled' && <Alert tone="error">Facture annulée — motif : {doc.cancelReason}. Le numéro {doc.number} est conservé.</Alert>}
        {kind === 'invoice' && doc.status === 'issued' && <Alert tone="info">Une facture émise ne peut plus être modifiée ni supprimée. Pour la corriger, créez un avoir ; pour l'annuler (sans règlement), utilisez « Annuler ».</Alert>}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="min-w-0 p-5 lg:col-span-2">
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
            <div><dt className="text-slate-500">Date</dt><dd>{fmtDate(doc.issueDate)}</dd></div>
            {kind === 'sales_order' && <div><dt className="text-slate-500">Livraison souhaitée</dt><dd>{fmtDate(doc.expectedDate)}</dd></div>}
            {kind === 'quote' && <div><dt className="text-slate-500">Valable jusqu'au</dt><dd>{fmtDate(doc.validUntil)}</dd></div>}
            {kind === 'invoice' && <div><dt className="text-slate-500">Échéance</dt><dd>{fmtDate(doc.dueDate)}</dd></div>}
            <div><dt className="text-slate-500">Devise</dt><dd>{cur}{cur !== 'TND' ? ` (1 ${cur} = ${Number(doc.exchangeRate)} TND)` : ''}</dd></div>
            <div><dt className="text-slate-500">Client</dt><dd>{doc.client.name}</dd></div>
            <div><dt className="text-slate-500">Matricule fiscal</dt><dd>{doc.client.taxId ?? '—'}</dd></div>
            <div><dt className="text-slate-500">Paiement</dt><dd>{doc.paymentTermsDays ? `${doc.paymentTermsDays} jours` : 'Comptant'}</dd></div>
          </dl>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead className="border-y border-slate-200 bg-slate-50 text-xs uppercase text-slate-500"><tr><th className="px-3 py-2">Désignation</th><th className="px-3 py-2 text-right">Qté</th><th className="px-3 py-2 text-right">PU HT</th><th className="px-3 py-2 text-right">Rem.</th><th className="px-3 py-2 text-right">TVA</th><th className="px-3 py-2 text-right">Total HT</th></tr></thead>
              <tbody className="divide-y divide-slate-100">{doc.lines.map((l) => (
                <tr key={l.id}><td className="px-3 py-2">{l.description}</td><td className="px-3 py-2 text-right tabular-nums">{Number(l.quantity)} {l.unit !== 'unité' ? l.unit : ''}</td><td className="px-3 py-2 text-right tabular-nums">{fmtMoney(l.unitPrice, '')}</td><td className="px-3 py-2 text-right">{Number(l.discountPct) ? `${Number(l.discountPct)} %` : ''}</td><td className="px-3 py-2 text-right">{Number(l.taxRate)} %</td><td className="px-3 py-2 text-right tabular-nums">{fmtMoney(l.netAmount, '')}</td></tr>))}</tbody>
            </table>
          </div>
          {(doc.notes || doc.terms) && <div className="mt-4 grid gap-3 text-sm text-slate-600 sm:grid-cols-2">{doc.notes && <div><p className="font-medium text-slate-800">Notes</p><p className="whitespace-pre-line">{doc.notes}</p></div>}{doc.terms && <div><p className="font-medium text-slate-800">Conditions générales</p><p className="whitespace-pre-line">{doc.terms}</p></div>}</div>}
        </Card>

        <div className="space-y-4">
          <Card className="p-5">
            <dl className="space-y-1.5 text-sm" data-testid="doc-totals">
              {Number(doc.globalDiscountAmount) > 0 && <div className="flex justify-between"><dt>Remise globale ({Number(doc.globalDiscountPct)} %)</dt><dd className="tabular-nums">- {fmtMoney(doc.globalDiscountAmount, cur)}</dd></div>}
              <div className="flex justify-between"><dt>Total HT</dt><dd className="tabular-nums">{fmtMoney(doc.totalHt, cur)}</dd></div>
              {doc.taxes.map((t) => <div key={t.taxRate} className="flex justify-between text-slate-500"><dt>TVA {Number(t.taxRate)} % sur {fmtMoney(t.base, '')}</dt><dd className="tabular-nums">{fmtMoney(t.amount, cur)}</dd></div>)}
              {Number(doc.fodecAmount) > 0 && <div className="flex justify-between"><dt>FODEC ({Number(doc.fodecRate)} %)</dt><dd className="tabular-nums" data-testid="view-fodec">{fmtMoney(doc.fodecAmount, cur)}</dd></div>}
              <div className="flex justify-between"><dt>Total TVA</dt><dd className="tabular-nums">{fmtMoney(doc.totalTax, cur)}</dd></div>
              <div className="flex justify-between font-medium"><dt>Total TTC</dt><dd className="tabular-nums" data-testid="view-ttc">{fmtMoney(doc.totalTtc, cur)}</dd></div>
              {Number(doc.stampDuty) > 0 && <div className="flex justify-between"><dt>Timbre fiscal</dt><dd className="tabular-nums">{fmtMoney(doc.stampDuty, cur)}</dd></div>}
              {Number(doc.withholdingAmount) > 0 && <div className="flex justify-between"><dt>Retenue à la source ({Number(doc.withholdingRate)} %)</dt><dd className="tabular-nums">- {fmtMoney(doc.withholdingAmount, cur)}</dd></div>}
              {kind === 'invoice' && doc.addedWithholding && <div className="flex justify-between text-slate-600" data-testid="added-rs"><dt>Retenue à la source enregistrée après émission ({Number(doc.addedWithholding.rate)} %)</dt><dd className="tabular-nums">{fmtMoney(doc.addedWithholding.amount, cur)}</dd></div>}
              {kind === 'invoice' && doc.deposits?.map((d) => <div key={d.id} className="flex justify-between"><dt>Acompte {d.number}</dt><dd className="tabular-nums">- {fmtMoney(d.amount, cur)}</dd></div>)}
              <div className="flex justify-between border-t border-slate-200 pt-2 text-base font-semibold text-brand-700"><dt>{kind === 'credit_note' ? 'Net à restituer' : 'Net à payer'}</dt><dd className="tabular-nums">{fmtMoney(doc.netPayable, cur)}</dd></div>
              {kind === 'invoice' && doc.status === 'issued' && <>
                <div className="flex justify-between text-slate-500"><dt>Déjà réglé</dt><dd className="tabular-nums">{fmtMoney(doc.paidAmount, cur)}</dd></div>
                {Number(doc.credited) > 0 && <div className="flex justify-between text-slate-500"><dt>Avoirs émis</dt><dd className="tabular-nums">- {fmtMoney(doc.credited, cur)}</dd></div>}
                <div className="flex justify-between font-medium"><dt>Solde restant</dt><dd className="tabular-nums" data-testid="balance">{fmtMoney(doc.balance, cur)}</dd></div>
              </>}
            </dl>
          </Card>
          {kind === 'sales_order' && <OrderPanels order={doc} />}
          {kind === 'invoice' && doc.payments?.length > 0 && (
            <Card className="p-5"><h2 className="mb-2 text-sm font-semibold">Règlements</h2><ul className="space-y-1 text-sm" data-testid="payments-list">{doc.payments.map((p) => <li key={p.id} className={p.status === 'cancelled' ? 'text-slate-400 line-through' : ''}>{p.number} · {fmtDate(p.date)} · {METHOD_LABELS[p.method]} · {fmtMoney(p.amount, cur)}{p.status === 'cancelled' ? ' (annulé)' : ''}</li>)}</ul></Card>
          )}
          {kind === 'invoice' && doc.creditNotes?.length > 0 && (
            <Card className="p-5"><h2 className="mb-2 text-sm font-semibold">Avoirs liés</h2><ul className="space-y-1 text-sm">{doc.creditNotes.map((c) => <li key={c.id}><Link className="text-brand-700 hover:underline" to={`/sales/credit-notes/${c.id}`}>{c.number ?? 'Brouillon'}</Link> · {fmtMoney(c.totalTtc, cur)} · {c.status === 'issued' ? 'émis' : c.status}</li>)}</ul></Card>
          )}
          <Card className="p-5">
            <button className="flex w-full items-center gap-2 text-sm font-semibold" onClick={async () => setHist(hist ? null : (await api.get(`${cfg.api}/${id}/history`)).data.data)}><History size={16} aria-hidden /> Historique</button>
            {hist && <ul className="mt-3 space-y-2 text-sm" data-testid="history">{hist.map((h, i) => <li key={i}><span className="font-medium">{ACTION_LABELS[h.action] ?? h.action}</span> <span className="text-slate-500">· {h.by ?? 'système'} · {new Date(h.at).toLocaleString('fr-FR')}</span></li>)}</ul>}
          </Card>
        </div>
      </div>

      {modal === 'mail' && <EmailModal doc={doc} cfg={cfg} onClose={() => setModal(null)} onDone={(l) => { setModal(null); setNotice({ tone: 'success', text: `E-mail envoyé à ${l.join(', ')}` }); load(); }} />}
      {modal === 'delivery' && <DeliveryModal order={doc} onClose={() => setModal(null)} onDone={(n) => navigate(`/sales/delivery-notes/${n.id}`)} />}
      {modal === 'deposit' && <DepositModal order={doc} onClose={() => setModal(null)} onDone={(r) => navigate(`/sales/invoices/${r.invoiceId}`)} />}
      {modal === 'pay' && <PaymentModal client={{ id: doc.clientId, name: doc.client.name }} invoice={doc} onClose={() => setModal(null)} onDone={(p) => { setModal(null); setNotice({ tone: 'success', text: `Règlement ${p.number} enregistré` }); load(); }} />}
      {modal === 'rs' && <WithholdingModal kind="sales" invoice={doc} onClose={() => setModal(null)} onDone={(p) => { setModal(null); setNotice({ tone: 'success', text: `Retenue à la source ${p.number} enregistrée (${fmtMoney(p.amount, cur)})` }); load(); }} />}
      {modal === 'rs-cancel' && doc.addedWithholding && <CancelWithholdingModal kind="sales" added={doc.addedWithholding} onClose={() => setModal(null)} onDone={() => { setModal(null); setNotice({ tone: 'success', text: 'Retenue à la source annulée' }); load(); }} />}
      {modal === 'credit' && <CreditModal invoice={doc} onClose={() => setModal(null)} onDone={(cn) => navigate(`/sales/credit-notes/${cn.id}`)} />}
      {modal === 'cancel' && (
        <Modal title={`Annuler ${kind === 'sales_order' ? 'la commande' : 'la facture'} ${doc.number}`} onClose={() => setModal(null)}>
          <p className="mb-3 text-sm text-slate-600">{kind === 'sales_order' ? 'La commande reste consultable. Impossible si des bons de livraison ou des factures existent.' : 'La facture reste consultable et son numéro est conservé. Impossible si un règlement ou un avoir existe.'}</p>
          <input aria-label="Motif d'annulation" value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} maxLength={255} placeholder="Motif (obligatoire)" className="block w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
          <div className="mt-4 flex justify-end gap-2"><Button variant="secondary" onClick={() => setModal(null)}>Retour</Button><Button variant="danger" disabled={cancelReason.trim().length < 5} loading={busy === 'cancel'} onClick={async () => { await run('cancel', () => api.post(`${cfg.api}/${id}/cancel`, { reason: cancelReason }), 'Facture annulée'); setModal(null); }}>Annuler la facture</Button></div>
        </Modal>
      )}
      {modal === 'delete' && (
        <Modal title="Supprimer ce brouillon ?" onClose={() => setModal(null)}>
          <p className="text-sm text-slate-600">Le brouillon n'a pas de numéro : sa suppression ne crée aucun trou dans la numérotation.</p>
          <div className="mt-4 flex justify-end gap-2"><Button variant="secondary" onClick={() => setModal(null)}>Annuler</Button><Button variant="danger" onClick={async () => { try { await api.delete(`${cfg.api}/${id}`); navigate(cfg.base); } catch (e) { setModal(null); setNotice({ tone: 'error', text: errorMessage(e) }); } }}>Supprimer</Button></div>
        </Modal>
      )}
    </>
  );
}
