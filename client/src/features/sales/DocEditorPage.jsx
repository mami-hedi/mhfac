import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useFieldArray, useForm } from 'react-hook-form';
import { Plus, Trash2 } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { api, errorMessage } from '../../services/api.js';
import { Alert, Button, Card, Input, PageHeader, Select, Spinner } from '../../components/ui/index.jsx';
import { Combobox, addDays, fmtMoney, searchClients, searchProducts, todayIso } from './shared.jsx';
import { CFG } from './DocListPage.jsx';
import { QuickPartyModal, QuickProductModal } from '../masterdata/QuickCreate.jsx';

const emptyLine = { productId: null, description: '', quantity: '1', unit: 'unité', unitPrice: '0', discountPct: '0', taxRateId: '', fodec: false };

// Les totaux affichés viennent TOUS du serveur (/sales/preview) : l'interface n'additionne rien.
export default function DocEditorPage({ kind }) {
  const cfg = CFG[kind]; const { id } = useParams(); const navigate = useNavigate(); const { company } = useAuth();
  const isEdit = Boolean(id);
  const [ref, setRef] = useState({ loading: true, taxRates: [], settings: null });
  const [clientName, setClientName] = useState('');
  const [error, setError] = useState('');
  const [preview, setPreview] = useState({ calc: null, error: '' });
  const [saving, setSaving] = useState(false);
  const { can } = useAuth(); const [quick, setQuick] = useState(null);
  const [linked, setLinked] = useState(false); const [whs, setWhs] = useState([]); const [check, setCheck] = useState(null);
  const { register, control, handleSubmit, reset, setValue, watch, formState: { errors } } = useForm({
    defaultValues: { clientId: '', issueDate: todayIso(), secondDate: '', currency: company.currency, exchangeRate: '', globalDiscountPct: '0', applyStampDuty: false, withholdingPct: '0', paymentTermsDays: '', notes: '', terms: '', stockExit: false, warehouseId: '', lines: [{ ...emptyLine }] },
  });
  const { fields, append, remove } = useFieldArray({ control, name: 'lines' });

  useEffect(() => {
    (async () => {
      try {
        const [t, s] = await Promise.all([api.get('/tax-rates'), api.get('/companies/current/settings').catch(() => null)]);
        const taxRates = t.data.data; const settings = s?.data.data ?? null;
        const def = taxRates.find((x) => x.isDefault && x.isActive)?.id ?? '';
        setRef({ loading: false, taxRates, settings });
        if (isEdit) {
          const d = (await api.get(`${cfg.api}/${id}`)).data.data;
          if (d.status !== 'draft' && !(kind === 'quote' && d.status === 'sent')) { navigate(`${cfg.base}/${id}`, { replace: true }); return; }
          setClientName(d.client.name);
          const rateToId = (r) => taxRates.find((x) => Number(x.rate) === Number(r) && x.isActive)?.id ?? '';
          setLinked(!!(d.order || d.deliveryNote));
          reset({ clientId: d.clientId, issueDate: d.issueDate, secondDate: kind === 'quote' ? d.validUntil : kind === 'sales_order' ? (d.expectedDate ?? '') : d.dueDate, currency: d.currency, exchangeRate: d.currency === company.currency ? '' : d.exchangeRate, globalDiscountPct: d.globalDiscountPct, applyStampDuty: Number(d.stampDuty) > 0, withholdingPct: d.withholdingRate, paymentTermsDays: String(d.paymentTermsDays), notes: d.notes ?? '', terms: d.terms ?? '', stockExit: !!d.stockExit, warehouseId: d.warehouse?.id ?? '',
            lines: d.lines.map((l) => ({ productId: l.productId, fodec: !!l.fodec, description: l.description, quantity: l.quantity.replace(/\.?0+$/, ''), unit: l.unit, unitPrice: l.unitPrice, discountPct: l.discountPct, taxRateId: rateToId(l.taxRate) })) });
        } else if (settings) {
          setValue('applyStampDuty', settings.sales.stampDutyEnabled); setValue('withholdingPct', settings.sales.defaultWithholdingPct);
          setValue('terms', settings.sales.defaultTerms ?? '');
          if (kind === 'quote') setValue('secondDate', addDays(todayIso(), settings.sales.quoteValidityDays));
          setValue('lines.0.taxRateId', def);
        } else setValue('lines.0.taxRateId', def);
      } catch (e) { setError(errorMessage(e)); setRef((r) => ({ ...r, loading: false })); }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const toBody = (v) => {
    const body = {
      clientId: v.clientId, issueDate: v.issueDate, currency: v.currency || undefined, exchangeRate: v.currency !== company.currency ? v.exchangeRate || undefined : undefined,
      globalDiscountPct: v.globalDiscountPct || '0', applyStampDuty: v.applyStampDuty, withholdingPct: v.withholdingPct || '0', notes: v.notes || null, terms: v.terms || null,
      lines: v.lines.map((l) => ({ productId: l.productId || null, fodec: fodecOn ? !!l.fodec : undefined, description: l.description || undefined, quantity: l.quantity, unit: l.unit || undefined, unitPrice: l.unitPrice, discountPct: l.discountPct || '0', taxRateId: l.taxRateId || undefined })),
    };
    if (kind === 'invoice' && v.stockExit && !linked) { body.stockExit = true; if (v.warehouseId) body.warehouseId = v.warehouseId; }
    if (v.paymentTermsDays !== '') body.paymentTermsDays = Number(v.paymentTermsDays);
    if (v.secondDate) body[{ quote: 'validUntil', sales_order: 'expectedDate' }[kind] ?? 'dueDate'] = v.secondDate;
    return body;
  };

  const values = watch(); const key = JSON.stringify(values);
  useEffect(() => {
    if (ref.loading || !values.clientId) { setPreview({ calc: null, error: '' }); return undefined; }
    const t = setTimeout(async () => {
      try { setPreview({ calc: (await api.post('/sales/preview', toBody(values))).data.data, error: '' }); } catch (e) { setPreview({ calc: null, error: errorMessage(e) }); }
    }, 400);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, ref.loading]);

  // Entrepôts + contrôle indicatif de disponibilité (le serveur refait le contrôle à l'émission selon le réglage « stock négatif »)
  const canStockExit = kind === 'invoice' && !linked && can('delivery.validate') && can('stock.read');
  useEffect(() => { if (canStockExit) api.get('/stock/warehouses').then((w) => setWhs(w.data.data.filter((x) => x.status === 'active'))).catch(() => {}); }, [canStockExit]);
  const stockKey = JSON.stringify([values.stockExit, values.warehouseId, values.lines.map((l) => [l.productId, l.quantity])]);
  useEffect(() => {
    if (!canStockExit || !values.stockExit) { setCheck(null); return undefined; }
    const ls = values.lines.filter((l) => l.productId && Number(l.quantity) > 0).map((l) => ({ productId: l.productId, quantity: l.quantity }));
    if (!ls.length) { setCheck(null); return undefined; }
    const t = setTimeout(() => { api.post('/invoices/stock-check', { warehouseId: values.warehouseId || undefined, lines: ls }).then((r) => setCheck(r.data.data)).catch(() => setCheck(null)); }, 400);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stockKey, canStockExit]);

  const submit = handleSubmit(async (v) => {
    setError(''); setSaving(true);
    try {
      const r = isEdit ? await api.put(`${cfg.api}/${id}`, toBody(v)) : await api.post(cfg.api, toBody(v));
      navigate(`${cfg.base}/${r.data.data.id}`);
    } catch (e) { setError(errorMessage(e)); setSaving(false); }
  });

  const pickClient = (c) => { setValue('clientId', c.id, { shouldDirty: true }); setClientName(c.name); if (c.currency) setValue('currency', c.currency); setValue('paymentTermsDays', String(c.paymentTermsDays ?? 0)); if (kind === 'invoice') setValue('secondDate', addDays(values.issueDate, c.paymentTermsDays ?? 0)); };
  const pickProduct = (i, p) => {
    setValue(`lines.${i}.productId`, p.id); setValue(`lines.${i}.description`, p.name); setValue(`lines.${i}.unit`, p.unit); setValue(`lines.${i}.unitPrice`, p.salePrice); setValue(`lines.${i}.fodec`, !!p.fodecSubject);
    if (p.taxRate && ref.taxRates.find((t) => t.id === p.taxRate.id)?.isActive) setValue(`lines.${i}.taxRateId`, p.taxRate.id);
  };
  const foreign = values.currency && values.currency !== company.currency;
  const calc = preview.calc;
  const fodecOn = !!ref.settings?.sales?.fodecEnabled;
  const activeRates = useMemo(() => ref.taxRates.filter((t) => t.isActive), [ref.taxRates]);

  if (ref.loading) return <Spinner />;
  return (
    <>
    <form onSubmit={submit} noValidate>
      <PageHeader title={isEdit ? `Modifier le ${cfg.one}` : cfg.newLabel} subtitle="Les montants sont calculés et contrôlés par le serveur."
        actions={<div className="flex gap-2"><Button type="button" variant="secondary" onClick={() => navigate(isEdit ? `${cfg.base}/${id}` : cfg.base)}>Annuler</Button><Button type="submit" loading={saving} disabled={!values.clientId || !!preview.error}>Enregistrer le brouillon</Button></div>} />
      <div className="mb-4 space-y-3"><Alert tone="error">{error}</Alert></div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="space-y-4 p-5 lg:col-span-2">
          <h2 className="font-semibold">Informations</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <Combobox id="client" label="Client *" placeholder="Rechercher un client…" value={clientName} fetcher={searchClients}
                render={(c) => ({ label: c.name, node: <span><strong>{c.name}</strong> <span className="text-xs text-slate-500">{c.code}{c.taxId ? ` · ${c.taxId}` : ''}</span></span> })}
                onPick={(c) => pickClient(c)} />
              {can('client.write') && <button type="button" className="mt-1 text-xs font-medium text-brand-700 hover:underline" onClick={() => setQuick({ type: 'client' })}>+ Nouveau client</button>}
              <input type="hidden" {...register('clientId')} />
            </div>
            <Input label="Date" type="date" {...register('issueDate')} />
            <Input label={{ quote: 'Valable jusqu\'au', sales_order: 'Livraison souhaitée' }[kind] ?? 'Échéance'} type="date" {...register('secondDate')} />
            <Input label="Devise" maxLength={3} {...register('currency')} />
            {foreign && <Input label={`Taux de change (1 ${values.currency} = ? ${company.currency})`} inputMode="decimal" hint="Fixé à l'émission, jamais modifié ensuite." {...register('exchangeRate')} />}
            <Input label="Délai de paiement (jours)" type="number" min="0" {...register('paymentTermsDays')} />
            <Input label="Remise globale (%)" inputMode="decimal" {...register('globalDiscountPct')} />
            <Input label="Retenue à la source (%)" inputMode="decimal" hint="Calculée sur le TTC ; à valider avec votre comptable." {...register('withholdingPct')} />
            <div className="flex items-end gap-2 pb-2"><input id="stamp" type="checkbox" className="h-4 w-4" {...register('applyStampDuty')} /><label htmlFor="stamp" className="text-sm text-slate-700">Appliquer le timbre fiscal{Number(ref.settings?.sales.stampDutyAmount) > 0 ? ` (${fmtMoney(ref.settings.sales.stampDutyAmount, company.currency)})` : ''} <span className="text-slate-500">(facultatif)</span>{ref.settings && Number(ref.settings.sales.stampDutyAmount) <= 0 && <span className="block text-xs text-amber-700">Montant du timbre à 0 : définissez-le dans Paramètres pour qu'il s'applique.</span>}</label></div>
          </div>
        </Card>

        <Card className="p-5">
          <h2 className="mb-3 font-semibold">Totaux (calculés par le serveur)</h2>
          {preview.error && <Alert tone="error">{preview.error}</Alert>}
          {!calc && !preview.error && <p className="text-sm text-slate-500">Choisissez un client et ajoutez des lignes.</p>}
          {calc && (
            <dl className="space-y-1.5 text-sm" data-testid="totals">
              {Number(calc.globalDiscountAmount) > 0 && <div className="flex justify-between"><dt>Remise globale</dt><dd className="tabular-nums">- {fmtMoney(calc.globalDiscountAmount, calc.currency)}</dd></div>}
              <div className="flex justify-between"><dt>Total HT</dt><dd className="tabular-nums" data-testid="total-ht">{fmtMoney(calc.totalHt, calc.currency)}</dd></div>
              {calc.taxes.map((t) => <div key={t.taxRate} className="flex justify-between text-slate-500"><dt>TVA {Number(t.taxRate)} % sur {fmtMoney(t.base, '')}</dt><dd className="tabular-nums">{fmtMoney(t.amount, calc.currency)}</dd></div>)}
              {Number(calc.fodecAmount) > 0 && <div className="flex justify-between"><dt>FODEC ({Number(calc.fodecRate)} %)</dt><dd className="tabular-nums" data-testid="total-fodec">{fmtMoney(calc.fodecAmount, calc.currency)}</dd></div>}
              <div className="flex justify-between"><dt>Total TVA</dt><dd className="tabular-nums">{fmtMoney(calc.totalTax, calc.currency)}</dd></div>
              <div className="flex justify-between font-medium"><dt>Total TTC</dt><dd className="tabular-nums" data-testid="total-ttc">{fmtMoney(calc.totalTtc, calc.currency)}</dd></div>
              {Number(calc.stampDuty) > 0 && <div className="flex justify-between"><dt>Timbre fiscal</dt><dd className="tabular-nums">{fmtMoney(calc.stampDuty, calc.currency)}</dd></div>}
              {Number(calc.withholdingAmount) > 0 && <div className="flex justify-between"><dt>Retenue à la source</dt><dd className="tabular-nums">- {fmtMoney(calc.withholdingAmount, calc.currency)}</dd></div>}
              <div className="flex justify-between border-t border-slate-200 pt-2 text-base font-semibold text-brand-700"><dt>Net à payer</dt><dd className="tabular-nums" data-testid="net-payable">{fmtMoney(calc.netPayable, calc.currency)}</dd></div>
            </dl>
          )}
        </Card>
      </div>

      <Card className="mt-4 p-5">
        <div className="mb-3 flex items-center justify-between"><h2 className="font-semibold">Lignes</h2><Button type="button" variant="secondary" onClick={() => append({ ...emptyLine, taxRateId: activeRates.find((t) => t.isDefault)?.id ?? '' })}><Plus size={16} aria-hidden /> Ajouter une ligne</Button></div>
        <div className="space-y-3">
          {fields.map((f, i) => (
            <div key={f.id} className="rounded-md border border-slate-200 p-3" data-testid="line">
              <div className="grid gap-3 md:grid-cols-12">
                <div className="md:col-span-4"><Combobox label="Article (optionnel)" placeholder="Rechercher un article…" value="" fetcher={searchProducts} render={(p) => ({ label: p.name, node: <span><strong>{p.name}</strong> <span className="text-xs text-slate-500">{p.sku} · {fmtMoney(p.salePrice, '')}</span></span> })} onPick={(p) => pickProduct(i, p)} />
                  {can('product.write') && <button type="button" className="mt-1 text-xs font-medium text-brand-700 hover:underline" onClick={() => setQuick({ type: 'product', line: i })}>+ Nouvel article</button>}</div>
                <div className="md:col-span-8"><Input label="Désignation *" {...register(`lines.${i}.description`)} /></div>
                <Input className="md:col-span-2" label="Quantité" inputMode="decimal" {...register(`lines.${i}.quantity`)} />
                <Input className="md:col-span-2" label="Unité" {...register(`lines.${i}.unit`)} />
                <Input className="md:col-span-2" label="Prix unitaire HT" inputMode="decimal" {...register(`lines.${i}.unitPrice`)} />
                <Input className="md:col-span-2" label="Remise %" inputMode="decimal" {...register(`lines.${i}.discountPct`)} />
                <Select className="md:col-span-3" label="TVA" {...register(`lines.${i}.taxRateId`)}>{activeRates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select>
                {fodecOn && <div className="flex items-end gap-2 pb-2 md:col-span-2"><input id={`fodec-${i}`} type="checkbox" className="h-4 w-4" {...register(`lines.${i}.fodec`)} /><label htmlFor={`fodec-${i}`} className="text-sm text-slate-700">FODEC</label></div>}
                <div className="flex items-end justify-end md:col-span-1">{fields.length > 1 && <Button type="button" variant="ghost" aria-label={`Supprimer la ligne ${i + 1}`} onClick={() => remove(i)}><Trash2 size={16} className="text-red-600" /></Button>}</div>
              </div>
              {calc?.lines[i] && <p className="mt-2 text-right text-xs text-slate-500">Total HT de la ligne : <strong className="tabular-nums text-slate-800">{fmtMoney(calc.lines[i].netAmount, calc.currency)}</strong></p>}
            </div>
          ))}
        </div>
        {errors.lines && <p className="mt-2 text-xs text-red-600">Vérifiez les lignes.</p>}
      </Card>

      {canStockExit && (
        <Card className="mt-4 p-5">
          <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-0.5 h-4 w-4" {...register('stockExit')} /><span><strong>Sortir les articles du stock à l'émission</strong><br /><span className="text-slate-500">À cocher pour une vente directe (livraison immédiate ou comptoir). Seuls les articles « suivis en stock » sortent. Ne cochez pas si vous préférez générer un bon de livraison : la marchandise ne sort du stock qu'une seule fois.</span></span></label>
          {values.stockExit && whs.length > 0 && <div className="mt-2 max-w-xs"><label htmlFor="inv-wh" className="mb-1 block text-sm font-medium text-slate-700">Entrepôt</label><select id="inv-wh" className="block w-full rounded-md border border-slate-300 px-3 py-2 text-sm" {...register('warehouseId')}><option value="">Entrepôt par défaut</option>{whs.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select></div>}
          {values.stockExit && check?.hasShortage && <div className="mt-3"><Alert tone={check.willBlock ? 'error' : 'info'}>{check.willBlock ? 'Stock insuffisant : l\'émission sera refusée.' : 'Stock insuffisant (le stock négatif est autorisé : l\'émission passera et le stock deviendra négatif).'}<ul className="mt-1 list-disc pl-5">{check.items.filter((i) => i.insufficient).map((i) => <li key={i.productId}>{i.name} : disponible {Number(i.available)}, demandé {Number(i.requested)}</li>)}</ul></Alert></div>}
        </Card>
      )}

      <Card className="mt-4 grid gap-4 p-5 sm:grid-cols-2">
        <div><label htmlFor="notes" className="mb-1 block text-sm font-medium text-slate-700">Notes</label><textarea id="notes" rows={3} className="block w-full rounded-md border border-slate-300 px-3 py-2 text-sm" {...register('notes')} /></div>
        <div><label htmlFor="terms" className="mb-1 block text-sm font-medium text-slate-700">Conditions générales</label><textarea id="terms" rows={3} className="block w-full rounded-md border border-slate-300 px-3 py-2 text-sm" {...register('terms')} /></div>
      </Card>
    </form>
      {quick?.type === 'client' && <QuickPartyModal kind="client" onClose={() => setQuick(null)} onDone={(c) => { pickClient(c); setQuick(null); }} />}
      {quick?.type === 'product' && <QuickProductModal taxRates={ref.taxRates} initialName={values.lines[quick.line]?.description} onClose={() => setQuick(null)} onDone={(p) => { pickProduct(quick.line, p); setQuick(null); }} />}
    </>
  );
}
