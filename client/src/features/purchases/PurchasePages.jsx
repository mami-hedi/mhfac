import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useFieldArray, useForm } from 'react-hook-form';
import { Ban, CheckCircle2, Download, FileMinus, FileText, History, Mail, Pencil, PackageCheck, Plus, Receipt, Search, Trash2, Wallet } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { api, errorMessage } from '../../services/api.js';
import { Alert, Badge, Button, Card, EmptyState, Input, Modal, PageHeader, Select, Spinner } from '../../components/ui/index.jsx';
import { Pagination, downloadCsv, useDebounced } from '../masterdata/shared.jsx';
import ListFilters, { PAGE_SIZE, useDebouncedJson, useListFilters } from '../../components/ListFilters.jsx';
import { Combobox, fmtDate, fmtMoney, searchProducts, todayIso } from '../sales/shared.jsx';
import { EmailModal } from '../sales/DocViewPage.jsx';
import SupplierPaymentModal, { searchSuppliers } from './SupplierPaymentModal.jsx';
import WithholdingModal, { CancelWithholdingModal } from '../payments/WithholdingModal.jsx';
import { QuickPartyModal, QuickProductModal } from '../masterdata/QuickCreate.jsx';
import { ReturnModal } from '../stock/ReturnPages.jsx';
const field = 'block w-full rounded-md border border-slate-300 px-3 py-2 text-sm';

export const PCFG = {
  order: { api: '/purchase-orders', base: '/purchases/orders', perm: 'purchase', title: 'Bons de commande fournisseur', one: 'bon de commande', newLabel: 'Nouvelle commande', subtitle: 'Commandez vos achats, réceptionnez-les (totalement ou partiellement) puis saisissez la facture du fournisseur.',
    statuses: [['', 'Tous les statuts'], ['draft', 'Brouillons'], ['confirmed', 'Confirmées'], ['cancelled', 'Annulées']] },
  receipt: { api: '/purchase-receipts', base: '/purchases/receipts', perm: 'purchase_receipt', title: 'Bons de réception', one: 'bon de réception', subtitle: 'Un bon validé fait entrer les articles suivis en stock. Créez-le depuis une commande confirmée.',
    statuses: [['', 'Tous les statuts'], ['draft', 'Brouillons'], ['validated', 'Validés'], ['cancelled', 'Annulés']] },
  invoice: { api: '/purchase-invoices', base: '/purchases/invoices', perm: 'purchase', title: "Factures d'achat", one: "facture d'achat", newLabel: 'Nouvelle facture', subtitle: "Saisissez les factures reçues de vos fournisseurs : une fois enregistrées, elles sont figées et se corrigent par avoir.",
    statuses: [['', 'Tous les statuts'], ['draft', 'Brouillons'], ['recorded', 'Enregistrées'], ['cancelled', 'Annulées']] },
  credit_note: { api: '/purchase-credit-notes', base: '/purchases/credit-notes', perm: 'purchase', title: 'Avoirs fournisseur', one: 'avoir fournisseur', subtitle: "Avoirs reçus de vos fournisseurs. Créez-les depuis la facture d'achat concernée.",
    statuses: [['', 'Tous les statuts'], ['draft', 'Brouillons'], ['recorded', 'Enregistrés']] },
};
const ORDER_ST = { draft: ['Brouillon', 'neutral'], confirmed: ['Confirmée', 'green'], cancelled: ['Annulée', 'red'] };
const RECEIPT_ST = { draft: ['Brouillon', 'neutral'], validated: ['Validé', 'green'], cancelled: ['Annulé', 'red'] };
const INV_ST = { draft: ['Brouillon', 'neutral'], recorded: ['Enregistrée', 'blue'], cancelled: ['Annulée', 'red'] };
const PAY_ST = { unpaid: ['À payer', 'orange'], partial: ['Partiellement payée', 'blue'], paid: ['Payée', 'green'], credited: ['Soldée par avoir', 'green'] };
const RECV = { none: ['Non reçue', 'neutral'], partial: ['Reçue partiellement', 'orange'], complete: ['Reçue', 'green'] };
const INVC = { none: ['Non facturée', 'neutral'], partial: ['Facturée partiellement', 'orange'], invoiced: ['Facturée', 'green'] };

function Status({ kind, doc }) {
  if (kind === 'order') return <Badge tone={ORDER_ST[doc.status][1]}>{ORDER_ST[doc.status][0]}</Badge>;
  if (kind === 'receipt') return <Badge tone={RECEIPT_ST[doc.status][1]}>{RECEIPT_ST[doc.status][0]}</Badge>;
  if (doc.status === 'recorded' && kind === 'invoice' && doc.paymentStatus) {
    const [t, tone] = PAY_ST[doc.paymentStatus]; return <span className="inline-flex gap-1"><Badge tone={tone}>{t}</Badge>{doc.overdue && <Badge tone="red">En retard</Badge>}</span>;
  }
  return <Badge tone={INV_ST[doc.status][1]}>{kind === 'credit_note' && doc.status === 'recorded' ? 'Enregistré' : INV_ST[doc.status][0]}</Badge>;
}
const ACTIONS = { 'purchase_order.create': 'Création', 'purchase_order.update': 'Modification', 'purchase_order.confirm': 'Confirmée', 'purchase_order.cancel': 'Annulée', 'purchase_order.send': 'Envoyée par e-mail', 'purchase_receipt.create': 'Création', 'purchase_receipt.update': 'Modification', 'purchase_receipt.validate': 'Validé (entrée en stock)', 'purchase_receipt.cancel': 'Annulé (stock inversé)', 'purchase_invoice.create': 'Création', 'purchase_invoice.update': 'Modification', 'purchase_invoice.record': 'Enregistrée', 'purchase_invoice.cancel': 'Annulée', 'purchase_invoice.payment': 'Règlement enregistré', 'purchase_credit_note.create': 'Création', 'purchase_credit_note.record': 'Enregistré' };

// ───────── Listes ─────────
export function PurchaseList({ kind }) {
  const cfg = PCFG[kind]; const { can } = useAuth(); const navigate = useNavigate();
  const adv = true; const priced = kind !== 'receipt'; // filtres avancés + export CSV sur tous les documents d'achat ; un bon de réception n'a ni montant ni projet
  const fields = [
    { key: 'supplierId', label: 'Fournisseur', type: 'entity', path: '/suppliers', placeholder: 'Sélectionner un fournisseur' },
    ...(adv ? [{ key: 'from', label: 'Date de début', type: 'date' }, { key: 'to', label: 'Date de fin', type: 'date' }] : []),
    { key: 'status', label: 'Statut', type: 'select', options: cfg.statuses },
    ...(kind === 'invoice' ? [{ key: 'paymentStatus', label: 'Règlement', type: 'select', options: [['', 'Tous'], ['unpaid', 'Impayées'], ['partial', 'Partiellement payées'], ['paid', 'Payées'], ['overdue', 'En retard']] }] : []),
    { key: 'q', label: 'Recherche avancée', type: 'search', advanced: true, placeholder: adv ? 'N°, fournisseur, désignation, notes…' : 'Numéro, fournisseur…' },
    ...(priced ? [
      { key: 'minAmount', label: 'Montant minimum (TTC)', type: 'money', advanced: true }, { key: 'maxAmount', label: 'Montant maximum (TTC)', type: 'money', advanced: true },
      { key: 'projectId', label: 'Projet', type: 'entity', path: '/projects', placeholder: 'Sélectionner un projet', advanced: true, perm: 'project.read' }] : []),
    ...(adv ? [
      { key: 'productId', label: 'Produit', type: 'entity', path: '/products', placeholder: 'Sélectionner un produit', advanced: true, perm: 'product.read' }] : []),
  ];
  const filters = useListFilters(fields.map((x) => x.key)); const { page, params } = filters;
  const [state, setState] = useState({ loading: true });
  const debounced = useDebouncedJson(params);
  const load = useCallback(async () => {
    try { const r = await api.get(cfg.api, { params: { ...JSON.parse(debounced), page, limit: PAGE_SIZE } }); setState({ rows: r.data.data, meta: r.data.meta }); } catch (e) { setState({ error: errorMessage(e) }); }
  }, [cfg.api, debounced, page]);
  useEffect(() => { load(); }, [load]);
  const canCreate = (kind === 'order' || kind === 'invoice') && can(`${cfg.perm}.write`);
  return (
    <>
      <PageHeader title={cfg.title} subtitle={cfg.subtitle} actions={canCreate && <Button onClick={() => navigate(`${cfg.base}/new`)}><Plus size={16} aria-hidden /> {cfg.newLabel}</Button>} />
      <Card>
        <ListFilters fields={fields} filters={filters} exportPath={adv ? `${cfg.api}/export` : null} exportName={`${cfg.api.slice(1)}.csv`} onError={(t) => setState((st) => ({ ...st, exportError: t }))} />
        {state.exportError && <div className="px-4 pt-3"><Alert tone="error" onClose={() => setState((st) => ({ ...st, exportError: '' }))}>{state.exportError}</Alert></div>}
        {state.loading ? <Spinner /> : state.error ? <div className="p-4"><Alert tone="error">{state.error}</Alert></div> : state.rows.length === 0 ? (
          <EmptyState icon={FileText} title={filters.active ? 'Aucun résultat' : `Aucun ${cfg.one} pour l'instant`} action={canCreate && !filters.active && <Button onClick={() => navigate(`${cfg.base}/new`)}><Plus size={16} aria-hidden /> {cfg.newLabel}</Button>}>
            {kind === 'receipt' ? 'Ouvrez une commande confirmée puis choisissez « Créer un bon de réception ».' : kind === 'credit_note' ? "Ouvrez une facture d'achat enregistrée puis choisissez « Créer un avoir »." : 'Créez votre premier document : les totaux sont calculés par le serveur.'}</EmptyState>
        ) : (
          <div className="overflow-x-auto"><table className="w-full min-w-[760px] text-left text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase text-slate-500"><tr><th className="px-4 py-3">Numéro</th><th className="px-4 py-3">Fournisseur</th>{(kind === 'invoice' || kind === 'credit_note') && <th className="px-4 py-3">N° fournisseur</th>}{kind === 'receipt' && <th className="px-4 py-3">Commande / facture</th>}<th className="px-4 py-3">Date</th>{kind !== 'receipt' && <th className="px-4 py-3 text-right">Total TTC</th>}<th className="px-4 py-3">Statut</th></tr></thead>
            <tbody className="divide-y divide-slate-100">{state.rows.map((d) => (
              <tr key={d.id} className="hover:bg-slate-50">
                <td className="px-4 py-3 font-mono text-xs"><Link className="text-brand-700 hover:underline" to={`${cfg.base}/${d.id}`}>{d.number ?? 'Brouillon'}</Link></td>
                <td className="px-4 py-3 font-medium text-slate-900">{d.supplierName}</td>
                {(kind === 'invoice' || kind === 'credit_note') && <td className="px-4 py-3">{d.supplierRef}</td>}
                {kind === 'receipt' && <td className="px-4 py-3 font-mono text-xs">{d.order?.number ?? (d.sourceInvoice ? `Fact. ${d.sourceInvoice.number}` : '—')}</td>}
                <td className="px-4 py-3">{fmtDate(d.issueDate ?? d.receiptDate)}</td>
                {kind !== 'receipt' && <td className="px-4 py-3 text-right tabular-nums">{fmtMoney(d.totalTtc, d.currency)}</td>}
                <td className="px-4 py-3"><span className="inline-flex flex-wrap gap-1"><Status kind={kind} doc={d} />{kind === 'order' && d.status === 'confirmed' && <><Badge tone={RECV[d.receiptStatus][1]}>{RECV[d.receiptStatus][0]}</Badge><Badge tone={INVC[d.invoicingStatus][1]}>{INVC[d.invoicingStatus][0]}</Badge></>}{kind === 'receipt' && d.status === 'validated' && d.invoiced && <Badge tone="blue">Facturé</Badge>}</span></td>
              </tr>))}</tbody></table></div>
        )}
        <Pagination meta={state.meta} onPage={(p) => filters.set({ page: p })} />
      </Card>
    </>
  );
}

// ───────── Éditeur (commande et facture d'achat) ─────────
const emptyLine = { productId: null, description: '', quantity: '1', unit: 'unité', unitPrice: '0', discountPct: '0', taxRateId: '' };
export function PurchaseEditor({ kind }) {
  const cfg = PCFG[kind]; const { id } = useParams(); const navigate = useNavigate(); const { company } = useAuth();
  const isEdit = Boolean(id); const isInv = kind === 'invoice';
  const [ref, setRef] = useState({ loading: true, taxRates: [] }); const [supName, setSupName] = useState(''); const [error, setError] = useState('');
  const [preview, setPreview] = useState({ calc: null, error: '' }); const [saving, setSaving] = useState(false);
  const { can } = useAuth(); const [quick, setQuick] = useState(null);
  const { register, control, handleSubmit, reset, setValue, watch } = useForm({ defaultValues: { supplierId: '', issueDate: todayIso(), secondDate: '', supplierRef: '', currency: company.currency, exchangeRate: '', globalDiscountPct: '0', withholdingPct: '0', applyStampDuty: false, stampDutyAmount: '', paymentTermsDays: '', notes: '', stockEntry: false, warehouseId: '', lines: [{ ...emptyLine }] } });
  const [fromDoc, setFromDoc] = useState(false); const [whs, setWhs] = useState([]);
  const { fields, append, remove } = useFieldArray({ control, name: 'lines' });
  useEffect(() => {
    (async () => {
      try {
        const taxRates = (await api.get('/tax-rates')).data.data; const def = taxRates.find((x) => x.isDefault && x.isActive)?.id ?? '';
        setRef({ loading: false, taxRates });
        if (isInv && can('stock.read')) api.get('/stock/warehouses').then((w) => setWhs(w.data.data.filter((x) => x.status === 'active'))).catch(() => {});
        if (isEdit) {
          const d = (await api.get(`${cfg.api}/${id}`)).data.data;
          if (d.status !== 'draft') { navigate(`${cfg.base}/${id}`, { replace: true }); return; }
          setFromDoc(!!(d.order || d.receipt)); setSupName(d.supplier.name); const rateToId = (r) => taxRates.find((x) => Number(x.rate) === Number(r) && x.isActive)?.id ?? '';
          reset({ supplierId: d.supplierId, issueDate: d.issueDate, secondDate: (isInv ? d.dueDate : d.expectedDate) ?? '', supplierRef: d.supplierRef ?? '', currency: d.currency, exchangeRate: d.currency === company.currency ? '' : d.exchangeRate, globalDiscountPct: d.globalDiscountPct, withholdingPct: d.withholdingRate ?? '0', applyStampDuty: Number(d.stampDuty) > 0, stampDutyAmount: Number(d.stampDuty) > 0 ? d.stampDuty : '', paymentTermsDays: String(d.paymentTermsDays ?? ''), notes: d.notes ?? '', stockEntry: !!d.stockEntry, warehouseId: d.warehouse?.id ?? '',
            lines: d.lines.map((l) => ({ productId: l.productId, description: l.description, quantity: l.quantity.replace(/\.?0+$/, ''), unit: l.unit, unitPrice: l.unitPrice, discountPct: l.discountPct, taxRateId: rateToId(l.taxRate) })) });
        } else setValue('lines.0.taxRateId', def);
      } catch (e) { setError(errorMessage(e)); setRef((r) => ({ ...r, loading: false })); }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  const toBody = (v) => {
    const b = { supplierId: v.supplierId, issueDate: v.issueDate, currency: v.currency || undefined, exchangeRate: v.currency !== company.currency ? v.exchangeRate || undefined : undefined, globalDiscountPct: v.globalDiscountPct || '0', withholdingPct: v.withholdingPct || '0', notes: v.notes || null,
      lines: v.lines.map((l) => ({ productId: l.productId || null, description: l.description || undefined, quantity: l.quantity, unit: l.unit || undefined, unitPrice: l.unitPrice, discountPct: l.discountPct || '0', taxRateId: l.taxRateId || undefined })) };
    if (v.paymentTermsDays !== '') b.paymentTermsDays = Number(v.paymentTermsDays);
    if (isInv) { b.applyStampDuty = !!v.applyStampDuty; if (v.applyStampDuty && String(v.stampDutyAmount ?? '').trim() !== '') b.stampDutyAmount = String(v.stampDutyAmount).trim().replace(',', '.'); } // facultatif : le montant est celui de la facture du fournisseur
    if (isInv && !fromDoc) { b.stockEntry = !!v.stockEntry; if (v.stockEntry && v.warehouseId) b.warehouseId = v.warehouseId; }
    if (isInv) { b.supplierRef = v.supplierRef; if (v.secondDate) b.dueDate = v.secondDate; } else if (v.secondDate) b.expectedDate = v.secondDate;
    return b;
  };
  const values = watch(); const key = JSON.stringify(values);
  useEffect(() => {
    if (ref.loading || !values.supplierId) { setPreview({ calc: null, error: '' }); return undefined; }
    const t = setTimeout(async () => { try { const { supplierRef, ...b } = toBody(values); delete b.dueDate; delete b.expectedDate; setPreview({ calc: (await api.post('/purchases/preview', b)).data.data, error: '' }); } catch (e) { setPreview({ calc: null, error: errorMessage(e) }); } }, 400);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, ref.loading]);
  const submit = handleSubmit(async (v) => {
    setError(''); setSaving(true);
    try { const r = isEdit ? await api.put(`${cfg.api}/${id}`, toBody(v)) : await api.post(cfg.api, toBody(v)); navigate(`${cfg.base}/${r.data.data.id}`); } catch (e) { setError(errorMessage(e)); setSaving(false); }
  });
  const pickProduct = (i, p) => {
    setValue(`lines.${i}.productId`, p.id); setValue(`lines.${i}.description`, p.name); setValue(`lines.${i}.unit`, p.unit); setValue(`lines.${i}.unitPrice`, p.purchasePrice ?? p.salePrice);
    if (p.taxRate && ref.taxRates.find((t) => t.id === p.taxRate.id)?.isActive) setValue(`lines.${i}.taxRateId`, p.taxRate.id);
  };
  const pickSupplier = (s) => { setValue('supplierId', s.id, { shouldDirty: true }); setSupName(s.name); if (s.currency) setValue('currency', s.currency); setValue('paymentTermsDays', String(s.paymentTermsDays ?? 0)); };
  const calc = preview.calc; const foreign = values.currency && values.currency !== company.currency;
  const activeRates = useMemo(() => ref.taxRates.filter((t) => t.isActive), [ref.taxRates]);
  if (ref.loading) return <Spinner />;
  return (
    <>
    <form onSubmit={submit} noValidate>
      <PageHeader title={isEdit ? `Modifier le ${cfg.one}` : cfg.newLabel} subtitle="Les montants sont calculés et contrôlés par le serveur."
        actions={<div className="flex gap-2"><Button type="button" variant="secondary" onClick={() => navigate(isEdit ? `${cfg.base}/${id}` : cfg.base)}>Annuler</Button><Button type="submit" loading={saving} disabled={!values.supplierId || !!preview.error || (isInv && !values.supplierRef)}>Enregistrer le brouillon</Button></div>} />
      <div className="mb-4"><Alert tone="error">{error}</Alert></div>
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="space-y-4 p-5 lg:col-span-2">
          <h2 className="font-semibold">Informations</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <Combobox id="supplier" label="Fournisseur *" placeholder="Rechercher un fournisseur…" value={supName} fetcher={searchSuppliers}
                render={(s) => ({ label: s.name, node: <span><strong>{s.name}</strong> <span className="text-xs text-slate-500">{s.code}{s.taxId ? ` · ${s.taxId}` : ''}</span></span> })}
                onPick={(s) => pickSupplier(s)} />
              {can('supplier.write') && <button type="button" className="mt-1 text-xs font-medium text-brand-700 hover:underline" onClick={() => setQuick({ type: 'supplier' })}>+ Nouveau fournisseur</button>}
              <input type="hidden" {...register('supplierId')} />
            </div>
            {isInv && <Input label="N° de la facture du fournisseur *" maxLength={60} hint="Unique par fournisseur." {...register('supplierRef')} />}
            <Input label="Date" type="date" {...register('issueDate')} />
            <Input label={isInv ? 'Échéance' : 'Livraison attendue'} type="date" {...register('secondDate')} />
            <Input label="Devise" maxLength={3} {...register('currency')} />
            {foreign && <Input label={`Taux de change (1 ${values.currency} = ? ${company.currency})`} inputMode="decimal" {...register('exchangeRate')} />}
            <Input label="Délai de paiement (jours)" type="number" min="0" {...register('paymentTermsDays')} />
            <Input label="Remise globale (%)" inputMode="decimal" {...register('globalDiscountPct')} />
            <Input label="Retenue à la source (%)" inputMode="decimal" hint="Retenue sur le TTC, à reverser pour le compte du fournisseur ; à valider avec votre comptable." {...register('withholdingPct')} />
            {isInv && (
              <div className="sm:col-span-2 grid gap-3 sm:grid-cols-2">
                <div className="flex items-end gap-2 pb-2"><input id="pi-stamp" type="checkbox" className="h-4 w-4" {...register('applyStampDuty')} /><label htmlFor="pi-stamp" className="text-sm text-slate-700">Cette facture comporte un timbre fiscal <span className="text-slate-500">(facultatif)</span></label></div>
                {values.applyStampDuty && <Input label={`Montant du timbre (${values.currency || company.currency})`} inputMode="decimal" hint="Le montant figurant sur la facture du fournisseur. Vide = montant des paramètres de facturation." {...register('stampDutyAmount')} />}
              </div>
            )}
          </div>
          {isInv && !fromDoc && (
            <div className="mt-4 rounded-md border border-slate-200 bg-slate-50 p-3">
              <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-0.5 h-4 w-4" {...register('stockEntry')} /><span><strong>Entrer les articles en stock à l'enregistrement</strong><br /><span className="text-slate-500">À cocher pour une facture reçue directement, sans commande ni bon de réception. Seuls les articles « suivis en stock » entrent, au coût de la facture. Ne cochez pas si un bon de réception existe déjà (double comptage).</span></span></label>
              {values.stockEntry && whs.length > 0 && <div className="mt-2 max-w-xs"><label htmlFor="pi-wh" className="mb-1 block text-sm font-medium text-slate-700">Entrepôt</label><select id="pi-wh" className="block w-full rounded-md border border-slate-300 px-3 py-2 text-sm" {...register('warehouseId')}><option value="">Entrepôt par défaut</option>{whs.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select></div>}
            </div>
          )}
        </Card>
        <Card className="p-5">
          <h2 className="mb-3 font-semibold">Totaux (calculés par le serveur)</h2>
          {preview.error && <Alert tone="error">{preview.error}</Alert>}
          {!calc && !preview.error && <p className="text-sm text-slate-500">Choisissez un fournisseur et ajoutez des lignes.</p>}
          {calc && <dl className="space-y-1.5 text-sm" data-testid="totals">
            <div className="flex justify-between"><dt>Total HT</dt><dd className="tabular-nums" data-testid="total-ht">{fmtMoney(calc.totalHt, calc.currency)}</dd></div>
            {calc.taxes.map((t) => <div key={t.taxRate} className="flex justify-between text-slate-500"><dt>TVA {Number(t.taxRate)} %</dt><dd className="tabular-nums">{fmtMoney(t.amount, calc.currency)}</dd></div>)}
            <div className="flex justify-between border-t border-slate-200 pt-2 text-base font-semibold text-brand-700"><dt>Total TTC</dt><dd className="tabular-nums" data-testid="total-ttc">{fmtMoney(calc.totalTtc, calc.currency)}</dd></div>
            {Number(calc.stampDuty) > 0 && <div className="flex justify-between text-slate-500"><dt>Timbre fiscal</dt><dd className="tabular-nums">+ {fmtMoney(calc.stampDuty, calc.currency)}</dd></div>}
            {Number(calc.stampDuty) > 0 && Number(calc.withholdingAmount) <= 0 && <div className="flex justify-between font-semibold"><dt>Net à payer au fournisseur</dt><dd className="tabular-nums">{fmtMoney(calc.netPayable, calc.currency)}</dd></div>}
            {Number(calc.withholdingAmount) > 0 && <><div className="flex justify-between text-slate-500"><dt>Retenue à la source ({Number(calc.withholdingPct ?? values.withholdingPct)} %)</dt><dd className="tabular-nums">- {fmtMoney(calc.withholdingAmount, calc.currency)}</dd></div><div className="flex justify-between font-semibold"><dt>Net à payer au fournisseur</dt><dd className="tabular-nums">{fmtMoney(calc.netPayable, calc.currency)}</dd></div></>}
          </dl>}
        </Card>
      </div>
      <Card className="mt-4 p-5">
        <div className="mb-3 flex items-center justify-between"><h2 className="font-semibold">Lignes</h2><Button type="button" variant="secondary" onClick={() => append({ ...emptyLine, taxRateId: activeRates.find((t) => t.isDefault)?.id ?? '' })}><Plus size={16} aria-hidden /> Ajouter une ligne</Button></div>
        <div className="space-y-3">{fields.map((f, i) => (
          <div key={f.id} className="rounded-md border border-slate-200 p-3" data-testid="line"><div className="grid gap-3 md:grid-cols-12">
            <div className="md:col-span-4"><Combobox label="Article (optionnel)" placeholder="Rechercher un article…" value="" fetcher={searchProducts} render={(p) => ({ label: p.name, node: <span><strong>{p.name}</strong> <span className="text-xs text-slate-500">{p.sku}</span></span> })} onPick={(p) => pickProduct(i, p)} />
              {can('product.write') && <button type="button" className="mt-1 text-xs font-medium text-brand-700 hover:underline" onClick={() => setQuick({ type: 'product', line: i })}>+ Nouvel article</button>}</div>
            <div className="md:col-span-8"><Input label="Désignation *" {...register(`lines.${i}.description`)} /></div>
            <Input className="md:col-span-2" label="Quantité" inputMode="decimal" {...register(`lines.${i}.quantity`)} />
            <Input className="md:col-span-2" label="Unité" {...register(`lines.${i}.unit`)} />
            <Input className="md:col-span-2" label="Prix d'achat HT" inputMode="decimal" {...register(`lines.${i}.unitPrice`)} />
            <Input className="md:col-span-2" label="Remise %" inputMode="decimal" {...register(`lines.${i}.discountPct`)} />
            <Select className="md:col-span-3" label="TVA" {...register(`lines.${i}.taxRateId`)}>{activeRates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select>
            <div className="flex items-end justify-end md:col-span-1">{fields.length > 1 && <Button type="button" variant="ghost" aria-label={`Supprimer la ligne ${i + 1}`} onClick={() => remove(i)}><Trash2 size={16} className="text-red-600" /></Button>}</div>
          </div></div>))}</div>
      </Card>
      <Card className="mt-4 p-5"><label htmlFor="notes" className="mb-1 block text-sm font-medium text-slate-700">Notes</label><textarea id="notes" rows={3} className={field} {...register('notes')} /></Card>
    </form>
      {quick?.type === 'supplier' && <QuickPartyModal kind="supplier" onClose={() => setQuick(null)} onDone={(s) => { pickSupplier(s); setQuick(null); }} />}
      {quick?.type === 'product' && <QuickProductModal taxRates={ref.taxRates} initialName={values.lines[quick.line]?.description} onClose={() => setQuick(null)} onDone={(p) => { pickProduct(quick.line, p); setQuick(null); }} />}
    </>
  );
}

// ───────── Fenêtres ─────────
function ReceiptModal({ order, onClose, onDone }) {
  const [date, setDate] = useState(todayIso()); const [ref, setRef] = useState(''); const [notes, setNotes] = useState(''); const [plate, setPlate] = useState('');
  const [qty, setQty] = useState(() => Object.fromEntries(order.lines.map((l) => [l.id, Number(l.receivableQuantity) > 0 ? String(Number(l.receivableQuantity)) : '0'])));
  const [whs, setWhs] = useState([]); const [wh, setWh] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  useEffect(() => { api.get('/stock/warehouses').then((r) => { const a = r.data.data.filter((w) => w.status === 'active'); setWhs(a); setWh(a.find((w) => w.isDefault)?.id ?? a[0]?.id ?? ''); }).catch(() => {}); }, []);
  const submit = async () => {
    const lines = order.lines.filter((l) => Number(qty[l.id]) > 0).map((l) => ({ orderLineId: l.id, quantity: qty[l.id] }));
    if (!lines.length) { setError('Indiquez au moins une quantité reçue.'); return; }
    setBusy(true); setError('');
    try { onDone((await api.post('/purchase-receipts', { orderId: order.id, warehouseId: wh || undefined, receiptDate: date, supplierRef: ref || null, vehiclePlate: plate.trim() || null, notes: notes || null, lines })).data.data); } catch (e) { setError(errorMessage(e)); setBusy(false); }
  };
  return (
    <Modal title={`Bon de réception — ${order.number}`} onClose={onClose} size="lg"><div className="space-y-4">
      <Alert tone="error">{error}</Alert>
      <div className="grid gap-3 sm:grid-cols-3">
        <div><label htmlFor="rc-date" className="mb-1 block text-sm font-medium">Date de réception</label><input id="rc-date" type="date" value={date} max={todayIso()} onChange={(e) => setDate(e.target.value)} className={field} /></div>
        <div><label htmlFor="rc-wh" className="mb-1 block text-sm font-medium">Entrée en stock dans</label><select id="rc-wh" value={wh} onChange={(e) => setWh(e.target.value)} className={field}>{whs.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select></div>
        <div><label htmlFor="rc-ref" className="mb-1 block text-sm font-medium">N° du bon fournisseur</label><input id="rc-ref" value={ref} maxLength={60} onChange={(e) => setRef(e.target.value)} className={field} /></div>
        <div><label htmlFor="rc-plate" className="mb-1 block text-sm font-medium">Matricule du véhicule</label><input id="rc-plate" value={plate} maxLength={20} placeholder="Ex. 123 TUN 4567" onChange={(e) => setPlate(e.target.value)} className={field} /></div>
      </div>
      <table className="w-full text-sm"><thead className="text-left text-xs uppercase text-slate-500"><tr><th className="py-2">Désignation</th><th className="py-2 text-right">Commandé</th><th className="py-2 text-right">Reste à recevoir</th><th className="py-2 text-right">Reçu</th></tr></thead>
        <tbody className="divide-y divide-slate-100">{order.lines.map((l) => (
          <tr key={l.id}><td className="py-2">{l.description}</td><td className="py-2 text-right tabular-nums">{Number(l.quantity)}</td><td className="py-2 text-right tabular-nums">{Number(l.receivableQuantity)}</td>
            <td className="py-2 text-right"><input aria-label={`Quantité reçue ligne ${l.position}`} disabled={Number(l.receivableQuantity) <= 0} value={qty[l.id]} onChange={(e) => setQty({ ...qty, [l.id]: e.target.value })} inputMode="decimal" className="w-24 rounded-md border border-slate-300 px-2 py-1 text-right tabular-nums" /></td></tr>))}</tbody></table>
      <div><label htmlFor="rc-notes" className="mb-1 block text-sm font-medium">Notes</label><textarea id="rc-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} className={field} /></div>
      <p className="text-xs text-slate-500">Brouillon : à la validation, les articles suivis en stock entrent dans l'entrepôt au coût de la commande (coût moyen pondéré).</p>
      <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Annuler</Button><Button loading={busy} onClick={submit}>Créer le bon (brouillon)</Button></div>
    </div></Modal>
  );
}
function RefModal({ title, onClose, onDone, action }) {
  const [supplierRef, setRef] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  return (
    <Modal title={title} onClose={onClose}><div className="space-y-4">
      <Alert tone="error">{error}</Alert>
      <div><label htmlFor="sref" className="mb-1 block text-sm font-medium">N° de la facture du fournisseur *</label><input id="sref" value={supplierRef} maxLength={60} onChange={(e) => setRef(e.target.value)} className={field} /></div>
      <p className="text-xs text-slate-500">La facture est créée en brouillon avec les prix, remises et TVA de la commande ; vous la vérifiez puis l'enregistrez.</p>
      <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Annuler</Button><Button loading={busy} disabled={!supplierRef.trim()} onClick={async () => { setBusy(true); try { onDone((await action(supplierRef.trim())).data.data); } catch (e) { setError(errorMessage(e)); setBusy(false); } }}>Créer la facture</Button></div>
    </div></Modal>
  );
}
function CreditModal({ invoice, onClose, onDone }) {
  const [reason, setReason] = useState(''); const [supplierRef, setRef] = useState('');
  const [qty, setQty] = useState(() => Object.fromEntries(invoice.lines.map((l) => [l.id, Number(l.creditableQuantity) > 0 ? String(Number(l.creditableQuantity)) : '0'])));
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const submit = async () => {
    const lines = invoice.lines.filter((l) => Number(qty[l.id]) > 0).map((l) => ({ invoiceLineId: l.id, quantity: qty[l.id] }));
    if (!lines.length) { setError('Indiquez au moins une quantité à créditer.'); return; }
    setBusy(true); setError('');
    try { onDone((await api.post('/purchase-credit-notes', { invoiceId: invoice.id, supplierRef, reason, lines })).data.data); } catch (e) { setError(errorMessage(e)); setBusy(false); }
  };
  return (
    <Modal title={`Avoir fournisseur sur ${invoice.number}`} onClose={onClose} size="lg"><div className="space-y-4">
      <Alert tone="error">{error}</Alert>
      <div className="grid gap-3 sm:grid-cols-2">
        <div><label htmlFor="cn-ref" className="mb-1 block text-sm font-medium">N° de l'avoir du fournisseur *</label><input id="cn-ref" value={supplierRef} maxLength={60} onChange={(e) => setRef(e.target.value)} className={field} /></div>
        <div><label htmlFor="cn-reason" className="mb-1 block text-sm font-medium">Motif *</label><input id="cn-reason" value={reason} maxLength={255} onChange={(e) => setReason(e.target.value)} className={field} placeholder="Ex. marchandise défectueuse" /></div>
      </div>
      <table className="w-full text-sm"><thead className="text-left text-xs uppercase text-slate-500"><tr><th className="py-2">Ligne</th><th className="py-2 text-right">Reste créditable</th><th className="py-2 text-right">Qté à créditer</th></tr></thead>
        <tbody className="divide-y divide-slate-100">{invoice.lines.map((l) => (
          <tr key={l.id}><td className="py-2">{l.description}</td><td className="py-2 text-right tabular-nums">{Number(l.creditableQuantity)}</td>
            <td className="py-2 text-right"><input aria-label={`Quantité à créditer ligne ${l.position}`} disabled={Number(l.creditableQuantity) <= 0} value={qty[l.id]} onChange={(e) => setQty({ ...qty, [l.id]: e.target.value })} inputMode="decimal" className="w-24 rounded-md border border-slate-300 px-2 py-1 text-right text-sm" /></td></tr>))}</tbody></table>
      <p className="text-xs text-slate-500">L'avoir ne modifie pas le stock : si des marchandises repartent chez le fournisseur, ajustez le stock par un bon de sortie.</p>
      <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Annuler</Button><Button loading={busy} disabled={reason.trim().length < 3 || !supplierRef.trim()} onClick={submit}>Créer le brouillon d'avoir</Button></div>
    </div></Modal>
  );
}

// ───────── Fiche document ─────────
export function PurchaseView({ kind }) {
  const cfg = PCFG[kind]; const { id } = useParams(); const navigate = useNavigate(); const { can } = useAuth();
  const [doc, setDoc] = useState(null); const [error, setError] = useState(''); const [notice, setNotice] = useState({ tone: 'success', text: '' });
  const [busy, setBusy] = useState(''); const [modal, setModal] = useState(null); const [reason, setReason] = useState(''); const [hist, setHist] = useState(null);
  const load = useCallback(async () => { try { setDoc((await api.get(`${cfg.api}/${id}`)).data.data); setHist(null); } catch (e) { setError(errorMessage(e)); } }, [cfg.api, id]);
  useEffect(() => { load(); }, [load]);
  const run = async (key, fn, ok) => { setBusy(key); setNotice({ tone: 'success', text: '' }); try { await fn(); if (ok) setNotice({ tone: 'success', text: ok }); await load(); } catch (e) { setNotice({ tone: 'error', text: errorMessage(e) }); } finally { setBusy(''); } };
  if (error) return <Alert tone="error">{error}</Alert>;
  if (!doc) return <Spinner />;
  const P = cfg.perm; const draft = doc.status === 'draft'; const cur = doc.currency; const hasAmounts = kind !== 'receipt';
  const title = doc.number ?? `${cfg.one[0].toUpperCase()}${cfg.one.slice(1)} (brouillon)`;
  const btn = (key, icon, label, fn, { variant = 'secondary', ok } = {}) => <Button key={key} variant={variant} loading={busy === key} onClick={() => run(key, fn, ok)}>{icon} {label}</Button>;
  const modalBtn = (key, icon, label, variant = 'secondary') => <Button key={key} variant={variant} onClick={() => { setReason(''); setModal(key); }}>{icon} {label}</Button>;
  const actions = [];
  if (kind === 'order') actions.push(<Button key="pdf" variant="secondary" onClick={() => downloadCsv(`${cfg.api}/${id}/pdf`, undefined, `${doc.number ?? 'brouillon'}.pdf`).catch((e) => setNotice({ tone: 'error', text: errorMessage(e) }))}><Download size={16} aria-hidden /> PDF</Button>);
  if (kind === 'order') {
    if (draft && can('purchase.write')) actions.push(<Button key="edit" variant="secondary" onClick={() => navigate(`${cfg.base}/${id}/edit`)}><Pencil size={16} aria-hidden /> Modifier</Button>);
    if (draft && can('purchase.validate')) actions.push(btn('confirm', <CheckCircle2 size={16} aria-hidden />, 'Confirmer la commande', () => api.post(`${cfg.api}/${id}/confirm`), { variant: 'primary', ok: 'Commande confirmée : numéro attribué' }));
    if (doc.status === 'confirmed') {
      if (can('purchase_receipt.write') && doc.lines.some((l) => Number(l.receivableQuantity) > 0)) actions.push(<Button key="rc" variant="primary" onClick={() => setModal('receipt')}><PackageCheck size={16} aria-hidden /> Créer un bon de réception</Button>);
      if (can('purchase.write') && doc.invoicingStatus === 'none') actions.push(<Button key="inv" variant="secondary" onClick={() => setModal('invoice-order')}><Receipt size={16} aria-hidden /> Facturer la commande</Button>);
      if (can('purchase.write')) actions.splice(1, 0, <Button key="mail" variant="secondary" onClick={() => setModal('mail')}><Mail size={16} aria-hidden /> Envoyer</Button>);
    }
    if (can('purchase.validate') && doc.status !== 'cancelled') actions.push(modalBtn('cancel', <Ban size={16} aria-hidden />, 'Annuler'));
  } else if (kind === 'receipt') {
    if (draft && can('purchase_receipt.validate')) actions.push(btn('validate', <CheckCircle2 size={16} aria-hidden />, 'Valider la réception', () => api.post(`${cfg.api}/${id}/validate`), { variant: 'primary', ok: 'Réception validée : stock mis à jour' }));
    if (doc.status === 'validated' && doc.order && can('purchase.write') && !doc.invoice) actions.push(<Button key="inv" variant="secondary" onClick={() => setModal('invoice-receipt')}><Receipt size={16} aria-hidden /> Facturer cette réception</Button>);
    if (doc.status === 'validated' && doc.order && can('purchase_return.write')) actions.push(<Button key="ret" variant="secondary" onClick={() => setModal('return')}>Créer un retour fournisseur</Button>);
    if (doc.status === 'validated' && can('purchase_receipt.validate')) actions.push(modalBtn('cancel', <Ban size={16} aria-hidden />, 'Annuler'));
  } else if (draft) {
    if (kind === 'invoice' && can('purchase.write')) actions.push(<Button key="edit" variant="secondary" onClick={() => navigate(`${cfg.base}/${id}/edit`)}><Pencil size={16} aria-hidden /> Modifier</Button>);
    if (can('purchase.validate')) actions.push(btn('record', <CheckCircle2 size={16} aria-hidden />, 'Enregistrer', () => api.post(`${cfg.api}/${id}/record`), { variant: 'primary', ok: 'Document enregistré : numéro interne attribué' }));
  } else if (kind === 'invoice' && doc.status === 'recorded') {
    if (can('payment.write') && Number(doc.balance) > 0) actions.push(<Button key="pay" variant="primary" onClick={() => setModal('pay')}><Wallet size={16} aria-hidden /> Enregistrer un règlement</Button>);
    if (can('payment.write') && Number(doc.balance) > 0 && !(Number(doc.withholdingAmount) > 0) && !doc.addedWithholding) actions.push(<Button key="rs" variant="secondary" onClick={() => setModal('rs')}>Enregistrer une retenue à la source</Button>);
    if (can('payment.validate') && doc.addedWithholding) actions.push(<Button key="rs-cancel" variant="secondary" onClick={() => setModal('rs-cancel')}>Annuler la retenue ajoutée</Button>);
    if (doc.logistics?.canGenerateReceipt && can('purchase_receipt.write')) actions.push(<Button key="gbr" variant="secondary" loading={busy === 'gbr'} onClick={() => run('gbr', async () => { const r = await api.post(`${cfg.api}/${id}/receipt`, {}); navigate(`/purchases/receipts/${r.data.data.receiptId}`); return r; }, 'Bon de réception créé (brouillon) : validez-le pour faire entrer le stock')}><PackageCheck size={16} aria-hidden /> Générer un Bon de Réception (BR)</Button>);
    if (can('purchase.write')) actions.push(<Button key="cn" variant="secondary" onClick={() => setModal('credit')}><FileMinus size={16} aria-hidden /> Créer un avoir</Button>);
    if (can('purchase.validate')) actions.push(modalBtn('cancel', <Ban size={16} aria-hidden />, 'Annuler'));
  }
  if (draft && can(`${P}.delete`)) actions.push(modalBtn('delete', <Trash2 size={16} className="text-red-600" aria-hidden />, 'Supprimer', 'ghost'));
  const sName = doc.supplierName ?? doc.supplier?.name;
  return (
    <>
      <PageHeader title={title} subtitle={<span className="inline-flex flex-wrap items-center gap-2"><Status kind={kind} doc={doc} /><span>{sName}</span>{doc.supplierRef && <span className="text-slate-500">· n° fournisseur {doc.supplierRef}</span>}</span>} actions={<div className="flex flex-wrap gap-2">{actions}</div>} />
      <div className="mb-4 space-y-3">
        <Alert tone={notice.tone} onClose={() => setNotice({ tone: 'success', text: '' })}>{notice.text}</Alert>
        {kind === 'order' && doc.status === 'cancelled' && <Alert tone="error">Commande annulée — motif : {doc.cancelReason}.</Alert>}
        {kind === 'receipt' && doc.sourceInvoice && <Alert tone="info">Généré depuis la facture d'achat <Link className="font-medium underline" to={`/purchases/invoices/${doc.sourceInvoice.id}`}>{doc.sourceInvoice.number}</Link>{doc.warehouse && <> · entrepôt {doc.warehouse.name}</>}. {doc.status === 'draft' ? 'La validation fait entrer les articles suivis en stock, au coût de la facture.' : ''}</Alert>}
        {kind === 'receipt' && doc.order && <Alert tone="info">Commande <Link className="font-medium underline" to={`/purchases/orders/${doc.order.id}`}>{doc.order.number}</Link>{doc.warehouse && <> · entrepôt {doc.warehouse.name}</>}{doc.vehiclePlate && <> · véhicule {doc.vehiclePlate}</>}{doc.invoice && <> · facturée : <Link className="font-medium underline" to={`/purchases/invoices/${doc.invoice.id}`}>{doc.invoice.number ?? 'brouillon'}</Link></>}.</Alert>}
        {kind === 'receipt' && doc.status === 'cancelled' && <Alert tone="error">Réception annulée — motif : {doc.cancelReason}. Le stock a été rétabli.</Alert>}
        {kind === 'invoice' && doc.stockEntry && <Alert tone="info">{doc.status === 'draft' ? 'À l\'enregistrement, les articles suivis en stock entreront en stock' : doc.status === 'recorded' ? `Articles entrés en stock par cette facture (${doc.stockMovements ?? 0} ligne(s))` : 'Entrée en stock annulée avec la facture'}{doc.warehouse ? ` — entrepôt ${doc.warehouse.name}` : ''}.</Alert>}
        {(kind === 'invoice' || kind === 'credit_note') && doc.order && <Alert tone="info">Commande <Link className="font-medium underline" to={`/purchases/orders/${doc.order.id}`}>{doc.order.number}</Link>{doc.receipt && <> · réception <Link className="font-medium underline" to={`/purchases/receipts/${doc.receipt.id}`}>{doc.receipt.number}</Link></>}</Alert>}
        {kind === 'credit_note' && doc.creditedInvoice && <Alert tone="info">Avoir sur la facture <Link className="font-medium underline" to={`/purchases/invoices/${doc.creditedInvoice.id}`}>{doc.creditedInvoice.number}</Link> — motif : {doc.creditReason}</Alert>}
        {kind === 'invoice' && doc.status === 'cancelled' && <Alert tone="error">Facture annulée — motif : {doc.cancelReason}. Le numéro {doc.number} est conservé.</Alert>}
        {kind === 'invoice' && doc.status === 'recorded' && doc.receipts?.some((x) => x.status !== 'cancelled') && <Alert tone="info">Bon de réception lié : {doc.receipts.filter((x) => x.status !== 'cancelled').map((x) => <Link key={x.id} className="font-medium underline" to={`/purchases/receipts/${x.id}`}>{x.number ?? 'brouillon'} ({x.status === 'draft' ? 'brouillon : à valider pour entrer en stock' : 'validé'})</Link>)}.</Alert>}
        {kind === 'invoice' && doc.status === 'recorded' && !doc.stockEntry && doc.logistics && !doc.logistics.canGenerateReceipt && !doc.receipts?.some((x) => x.status !== 'cancelled') && doc.logistics.reason && <p className="text-xs text-slate-500">Bon de réception : {doc.logistics.reason}.</p>}
        {kind === 'invoice' && doc.status === 'recorded' && <Alert tone="info">Une facture enregistrée ne peut plus être modifiée. Pour la corriger, créez un avoir fournisseur ; la facture ne modifie pas le stock (il entre par les réceptions).</Alert>}
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="min-w-0 p-5 lg:col-span-2">
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
            <div><dt className="text-slate-500">Date</dt><dd>{fmtDate(doc.issueDate ?? doc.receiptDate)}</dd></div>
            {kind === 'order' && <div><dt className="text-slate-500">Livraison attendue</dt><dd>{fmtDate(doc.expectedDate)}</dd></div>}
            {kind === 'invoice' && <div><dt className="text-slate-500">Échéance</dt><dd>{fmtDate(doc.dueDate)}</dd></div>}
            {hasAmounts && <div><dt className="text-slate-500">Devise</dt><dd>{cur}{cur !== 'TND' ? ` (1 ${cur} = ${Number(doc.exchangeRate)} TND)` : ''}</dd></div>}
            <div><dt className="text-slate-500">Fournisseur</dt><dd>{sName}</dd></div>
            <div><dt className="text-slate-500">Matricule fiscal</dt><dd>{doc.supplier?.taxId ?? '—'}</dd></div>
          </dl>
          <div className="mt-4 overflow-x-auto"><table className="w-full min-w-[560px] text-left text-sm">
            <thead className="border-y border-slate-200 bg-slate-50 text-xs uppercase text-slate-500"><tr><th className="px-3 py-2">Désignation</th><th className="px-3 py-2 text-right">Qté</th>{hasAmounts && <><th className="px-3 py-2 text-right">PU HT</th><th className="px-3 py-2 text-right">Rem.</th><th className="px-3 py-2 text-right">TVA</th></>}{kind === 'order' && <th className="px-3 py-2 text-right">Reçu</th>}{hasAmounts && <th className="px-3 py-2 text-right">Total HT</th>}</tr></thead>
            <tbody className="divide-y divide-slate-100">{doc.lines.map((l) => (
              <tr key={l.id}><td className="px-3 py-2">{l.description}</td><td className="px-3 py-2 text-right tabular-nums">{Number(l.quantity)} {l.unit !== 'unité' ? l.unit : ''}</td>
                {hasAmounts && <><td className="px-3 py-2 text-right tabular-nums">{fmtMoney(l.unitPrice, '')}</td><td className="px-3 py-2 text-right">{Number(l.discountPct) ? `${Number(l.discountPct)} %` : ''}</td><td className="px-3 py-2 text-right">{Number(l.taxRate)} %</td></>}
                {kind === 'order' && <td className="px-3 py-2 text-right tabular-nums">{Number(l.receivedQuantity)}</td>}
                {hasAmounts && <td className="px-3 py-2 text-right tabular-nums">{fmtMoney(l.netAmount, '')}</td>}</tr>))}</tbody></table></div>
          {doc.notes && <div className="mt-4 text-sm text-slate-600"><p className="font-medium text-slate-800">Notes</p><p className="whitespace-pre-line">{doc.notes}</p></div>}
        </Card>
        <div className="space-y-4">
          {hasAmounts && <Card className="p-5"><dl className="space-y-1.5 text-sm" data-testid="doc-totals">
            {Number(doc.globalDiscountAmount) > 0 && <div className="flex justify-between"><dt>Remise globale</dt><dd className="tabular-nums">- {fmtMoney(doc.globalDiscountAmount, cur)}</dd></div>}
            <div className="flex justify-between"><dt>Total HT</dt><dd className="tabular-nums">{fmtMoney(doc.totalHt, cur)}</dd></div>
            {doc.taxes.map((t) => <div key={t.taxRate} className="flex justify-between text-slate-500"><dt>TVA {Number(t.taxRate)} % sur {fmtMoney(t.base, '')}</dt><dd className="tabular-nums">{fmtMoney(t.amount, cur)}</dd></div>)}
            <div className="flex justify-between border-t border-slate-200 pt-2 text-base font-semibold text-brand-700"><dt>Total TTC</dt><dd className="tabular-nums" data-testid="view-ttc">{fmtMoney(doc.totalTtc, cur)}</dd></div>
            {Number(doc.stampDuty) > 0 && <div className="flex justify-between text-slate-500"><dt>Timbre fiscal</dt><dd className="tabular-nums">+ {fmtMoney(doc.stampDuty, cur)}</dd></div>}
            {Number(doc.withholdingAmount) > 0 && <div className="flex justify-between text-slate-500" data-testid="view-withholding"><dt>Retenue à la source ({Number(doc.withholdingRate)} %)</dt><dd className="tabular-nums">- {fmtMoney(doc.withholdingAmount, cur)}</dd></div>}
            {doc.addedWithholding && <div className="flex justify-between text-slate-500" data-testid="added-rs"><dt>Retenue à la source enregistrée après réception ({Number(doc.addedWithholding.rate)} %)</dt><dd className="tabular-nums">{fmtMoney(doc.addedWithholding.amount, cur)}</dd></div>}
            {Number(doc.withholdingAmount) > 0 && <div className="flex justify-between font-medium"><dt>Net à payer au fournisseur</dt><dd className="tabular-nums">{fmtMoney(doc.netPayable, cur)}</dd></div>}
            {kind === 'invoice' && doc.status === 'recorded' && <>
              <div className="flex justify-between text-slate-500"><dt>Déjà réglé</dt><dd className="tabular-nums">{fmtMoney(doc.paidAmount, cur)}</dd></div>
              {Number(doc.credited) > 0 && <div className="flex justify-between text-slate-500"><dt>Avoirs reçus</dt><dd className="tabular-nums">- {fmtMoney(doc.credited, cur)}</dd></div>}
              <div className="flex justify-between font-medium"><dt>Reste à payer</dt><dd className="tabular-nums" data-testid="balance">{fmtMoney(doc.balance, cur)}</dd></div></>}
          </dl></Card>}
          {kind === 'order' && <Card className="space-y-2 p-5 text-sm"><h2 className="font-semibold">Suivi</h2>
            <div className="flex flex-wrap gap-1"><Badge tone={RECV[doc.receiptStatus][1]}>{RECV[doc.receiptStatus][0]}</Badge><Badge tone={INVC[doc.invoicingStatus][1]}>{INVC[doc.invoicingStatus][0]}</Badge></div>
            {doc.receipts.length > 0 && <div><p className="text-xs uppercase text-slate-500">Réceptions</p><ul>{doc.receipts.map((r) => <li key={r.id}><Link className="text-brand-700 hover:underline" to={`/purchases/receipts/${r.id}`}>{r.number ?? 'Brouillon'}</Link> · {fmtDate(r.date)} · {RECEIPT_ST[r.status][0]}</li>)}</ul></div>}
            {doc.invoices.length > 0 && <div><p className="text-xs uppercase text-slate-500">Factures d'achat</p><ul>{doc.invoices.map((i) => <li key={i.id}><Link className="text-brand-700 hover:underline" to={`/purchases/invoices/${i.id}`}>{i.number ?? 'Brouillon'}</Link> · {i.supplierRef} · {fmtMoney(i.totalTtc, '')}</li>)}</ul></div>}</Card>}
          {kind === 'invoice' && doc.payments?.length > 0 && <Card className="p-5"><h2 className="mb-2 text-sm font-semibold">Règlements</h2><ul className="space-y-1 text-sm" data-testid="payments-list">{doc.payments.map((p) => <li key={p.id} className={p.status === 'cancelled' ? 'text-slate-400 line-through' : ''}>{p.number} · {fmtDate(p.date)} · {fmtMoney(p.amount, cur)}</li>)}</ul></Card>}
          {kind === 'invoice' && doc.creditNotes?.length > 0 && <Card className="p-5"><h2 className="mb-2 text-sm font-semibold">Avoirs liés</h2><ul className="space-y-1 text-sm">{doc.creditNotes.map((c) => <li key={c.id}><Link className="text-brand-700 hover:underline" to={`/purchases/credit-notes/${c.id}`}>{c.number ?? 'Brouillon'}</Link> · {c.supplierRef} · {fmtMoney(c.totalTtc, cur)}</li>)}</ul></Card>}
          <Card className="p-5">
            <button className="flex w-full items-center gap-2 text-sm font-semibold" onClick={async () => setHist(hist ? null : (await api.get(`${cfg.api}/${id}/history`)).data.data)}><History size={16} aria-hidden /> Historique</button>
            {hist && <ul className="mt-3 space-y-2 text-sm" data-testid="history">{hist.map((h, i) => <li key={i}><span className="font-medium">{ACTIONS[h.action] ?? h.action}</span> <span className="text-slate-500">· {h.by ?? 'système'} · {new Date(h.at).toLocaleString('fr-FR')}</span></li>)}</ul>}
          </Card>
        </div>
      </div>
      {modal === 'mail' && <EmailModal doc={{ ...doc, client: doc.client ?? doc.supplier }} cfg={{ ...cfg, api: cfg.api, one: 'bon de commande' }} onClose={() => setModal(null)} onDone={(l) => { setModal(null); setNotice({ tone: 'success', text: `E-mail envoyé à ${l.join(', ')}` }); load(); }} />}
      {modal === 'return' && <ReturnModal kind="purchase" sourceId={doc.id} onClose={() => setModal(null)} onDone={(r) => navigate(`/purchases/returns/${r.id}`)} />}
      {modal === 'receipt' && <ReceiptModal order={doc} onClose={() => setModal(null)} onDone={(r) => navigate(`/purchases/receipts/${r.id}`)} />}
      {modal === 'invoice-order' && <RefModal title={`Facturer la commande ${doc.number}`} onClose={() => setModal(null)} action={(supplierRef) => api.post(`/purchase-invoices/from-order/${doc.id}`, { supplierRef })} onDone={(i) => navigate(`/purchases/invoices/${i.id}`)} />}
      {modal === 'invoice-receipt' && <RefModal title={`Facturer la réception ${doc.number}`} onClose={() => setModal(null)} action={(supplierRef) => api.post(`/purchase-invoices/from-receipt/${doc.id}`, { supplierRef })} onDone={(i) => navigate(`/purchases/invoices/${i.id}`)} />}
      {modal === 'pay' && <SupplierPaymentModal supplier={{ id: doc.supplierId, name: sName }} invoice={doc} onClose={() => setModal(null)} onDone={(p) => { setModal(null); setNotice({ tone: 'success', text: `Règlement ${p.number} enregistré` }); load(); }} />}
      {modal === 'rs' && <WithholdingModal kind="purchase" invoice={doc} onClose={() => setModal(null)} onDone={(p) => { setModal(null); setNotice({ tone: 'success', text: `Retenue à la source ${p.number} enregistrée (${fmtMoney(p.amount, cur)})` }); load(); }} />}
      {modal === 'rs-cancel' && doc.addedWithholding && <CancelWithholdingModal kind="purchase" added={doc.addedWithholding} onClose={() => setModal(null)} onDone={() => { setModal(null); setNotice({ tone: 'success', text: 'Retenue à la source annulée' }); load(); }} />}
      {modal === 'credit' && <CreditModal invoice={doc} onClose={() => setModal(null)} onDone={(cn) => navigate(`/purchases/credit-notes/${cn.id}`)} />}
      {modal === 'cancel' && (
        <Modal title={`Annuler ${doc.number}`} onClose={() => setModal(null)}>
          <p className="mb-3 text-sm text-slate-600">{kind === 'receipt' ? 'Le stock entré est inversé. Impossible si une facture d\'achat existe pour cette réception.' : kind === 'order' ? 'Impossible si des réceptions ou des factures actives existent.' : 'Le numéro est conservé. Impossible si un règlement ou un avoir existe.'}</p>
          <input aria-label="Motif d'annulation" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={255} placeholder="Motif (obligatoire)" className={field} />
          <div className="mt-4 flex justify-end gap-2"><Button variant="secondary" onClick={() => setModal(null)}>Retour</Button><Button variant="danger" disabled={reason.trim().length < 5} loading={busy === 'cancel'} onClick={async () => { await run('cancel', () => api.post(`${cfg.api}/${id}/cancel`, { reason }), 'Document annulé'); setModal(null); }}>Confirmer l'annulation</Button></div>
        </Modal>)}
      {modal === 'delete' && (
        <Modal title="Supprimer ce brouillon ?" onClose={() => setModal(null)}>
          <p className="text-sm text-slate-600">Le brouillon est supprimé définitivement.</p>
          <div className="mt-4 flex justify-end gap-2"><Button variant="secondary" onClick={() => setModal(null)}>Annuler</Button><Button variant="danger" onClick={async () => { try { await api.delete(`${cfg.api}/${id}`); navigate(cfg.base); } catch (e) { setModal(null); setNotice({ tone: 'error', text: errorMessage(e) }); } }}>Supprimer</Button></div>
        </Modal>)}
    </>
  );
}
