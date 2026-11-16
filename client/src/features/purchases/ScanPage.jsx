import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ScanLine, Upload, Trash2, Plus } from 'lucide-react';
import { api, errorMessage } from '../../services/api.js';
import { Alert, Badge, Button, Card, PageHeader, Spinner } from '../../components/ui/index.jsx';

const field = 'block w-full rounded-md border border-slate-300 px-3 py-2 text-sm';
const lbl = 'mb-1 block text-sm font-medium text-slate-700';
const MAX_MB = 8;
const str = (v) => (v == null ? '' : String(v));

export default function ScanPage() {
  const navigate = useNavigate(); const input = useRef(null);
  const [scan, setScan] = useState(null); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [fileUrl, setFileUrl] = useState(null); const [mime, setMime] = useState('');
  const [taxRates, setTaxRates] = useState([]); const [suppliers, setSuppliers] = useState([]); const [form, setForm] = useState(null); const [warnings, setWarnings] = useState([]);
  useEffect(() => () => { if (fileUrl) URL.revokeObjectURL(fileUrl); }, [fileUrl]);

  const setF = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const setLine = (i, k, v) => setForm((f) => ({ ...f, lines: f.lines.map((l, j) => (j === i ? { ...l, [k]: v } : l)) }));

  const upload = async (file) => {
    setError('');
    if (!file) return;
    if (file.size > MAX_MB * 1024 * 1024) { setError(`Fichier trop volumineux (maximum ${MAX_MB} Mo)`); return; }
    setBusy(true);
    try {
      const [res, rates, sups] = await Promise.all([
        api.post(`/purchase-scans?filename=${encodeURIComponent(file.name)}`, file, { headers: { 'Content-Type': 'application/octet-stream' }, timeout: 120000 }),
        api.get('/tax-rates'), api.get('/suppliers', { params: { limit: 100, status: 'active' } })]);
      const s = res.data.data; const tr = rates.data.data.filter((t) => t.isActive); const ex = s.extraction;
      setScan(s); setTaxRates(tr); setSuppliers(sups.data.data); setMime(file.type || s.mimeType); setFileUrl(URL.createObjectURL(file));
      const byRate = (r) => tr.find((t) => Number(t.rate) === Number(r))?.id ?? '';
      setForm({ supplierId: s.supplierMatch?.id ?? '', supplierRef: str(ex.documentNumber), issueDate: str(ex.issueDate), dueDate: str(ex.dueDate), currency: ex.currency ?? 'TND', notes: '', stampOn: Number(ex.totals?.stampDuty) > 0, stampAmount: Number(ex.totals?.stampDuty) > 0 ? String(ex.totals.stampDuty) : '',
        lines: (ex.lines.length ? ex.lines : [{}]).map((l) => ({ description: str(l.description), quantity: str(l.quantity ?? 1), unitPrice: str(l.unitPriceExclTax ?? ''), discountPct: str(l.discountPct ?? 0), taxRateId: byRate(l.taxRatePct) })) });
    } catch (e) {
      const d = e?.response?.data?.error;
      setError(d?.code === 'DUPLICATE_SCAN' ? 'Ce document a déjà été scanné.' : errorMessage(e));
    }
    setBusy(false);
  };

  const createSupplier = async () => {
    setError(''); const s = scan.extraction.supplier;
    try { const r = await api.post('/suppliers', { name: s.name, taxId: s.taxId || undefined, email: s.email || undefined, phone: s.phone || undefined, address: s.address || undefined }); setSuppliers((l) => [...l, r.data.data]); setF('supplierId', r.data.data.id); }
    catch (e) { setError(errorMessage(e)); }
  };

  const submit = async () => {
    setBusy(true); setError('');
    try {
      const r = await api.post(`/purchase-scans/${scan.id}/draft`, { supplierId: form.supplierId, supplierRef: form.supplierRef, issueDate: form.issueDate, dueDate: form.dueDate || undefined, currency: form.currency || undefined, applyStampDuty: !!form.stampOn, ...(form.stampOn && String(form.stampAmount).trim() !== '' ? { stampDutyAmount: String(form.stampAmount).trim().replace(',', '.') } : {}),
        lines: form.lines.map((l) => ({ description: l.description, quantity: l.quantity, unitPrice: l.unitPrice, discountPct: l.discountPct || '0', taxRateId: l.taxRateId || undefined })) });
      const w = r.data.data.warnings; setWarnings(w);
      if (w.length === 0) navigate(`/purchases/invoices/${r.data.data.invoiceId}/edit`); else setScan({ ...scan, done: r.data.data.invoiceId });
    } catch (e) { setError(errorMessage(e)); }
    setBusy(false);
  };
  const discard = async () => { try { await api.delete(`/purchase-scans/${scan.id}`); setScan(null); setForm(null); setFileUrl(null); } catch (e) { setError(errorMessage(e)); } };

  const ready = form && form.supplierId && form.supplierRef && form.issueDate && form.lines.length > 0 && form.lines.every((l) => l.description && l.quantity && l.unitPrice !== '' && l.taxRateId);
  return (
    <>
      <PageHeader title="Scanner une facture fournisseur" subtitle="Téléversez un PDF ou une photo : les champs sont lus automatiquement, puis vous relisez et créez un brouillon de facture d'achat." />
      <div className="mb-4 space-y-2"><Alert tone="error">{error}</Alert></div>
      {!scan ? (
        <Card className="p-8 text-center">
          <ScanLine className="mx-auto mb-3 text-slate-400" size={40} aria-hidden />
          <p className="mb-1 font-medium">Choisissez la facture à lire</p>
          <p className="mb-4 text-sm text-slate-500">PDF, PNG, JPEG ou WebP — {MAX_MB} Mo maximum.</p>
          <input ref={input} data-testid="scan-file" type="file" accept="application/pdf,image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => { upload(e.target.files?.[0]); e.target.value = ''; }} />
          {busy ? <div className="flex items-center justify-center gap-2 text-sm text-slate-600"><Spinner /> Lecture en cours (quelques secondes)…</div> : <Button type="button" onClick={() => input.current?.click()}><Upload size={16} aria-hidden /> Téléverser un document</Button>}
          <div className="mx-auto mt-5 max-w-xl"><Alert tone="info">Lecture gratuite et locale : le document reste sur votre serveur, aucun service externe n'est utilisé. Rien n'est comptabilisé automatiquement : vous relisez tout avant de créer le brouillon. Pour de meilleurs résultats, utilisez un PDF numérique (le texte est lu directement) ou une photo nette, bien cadrée.</Alert></div>
        </Card>
      ) : scan.done ? (
        <Card className="space-y-3 p-6"><Alert tone="success">Brouillon créé.</Alert>
          <Alert tone="info">{`Points à vérifier : ${warnings.join(' · ')}`}</Alert>
          <Link className="inline-block rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white" to={`/purchases/invoices/${scan.done}/edit`}>Ouvrir le brouillon pour le corriger</Link></Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card className="p-3">
            <p className="mb-2 px-1 text-sm font-medium">{scan.fileName}</p>
            {mime === 'application/pdf' ? <iframe title="Document" src={fileUrl} className="h-[70vh] w-full rounded border" /> : <img alt="Document scanné" src={fileUrl} className="max-h-[70vh] w-full rounded border object-contain" />}
          </Card>
          <Card className="space-y-4 p-5">
            <Alert tone="info">Lecture automatique NON vérifiée : contrôlez chaque champ avec le document avant de créer le brouillon.</Alert>
            {scan.extraction.warnings.length > 0 && <Alert tone="info">{scan.extraction.warnings.join(' · ')}</Alert>}
            {scan.extraction.documentType === 'credit_note' && <Alert tone="error">Ce document ressemble à un avoir : il ne peut pas être créé ici.</Alert>}
            <div>
              <label htmlFor="sc-sup" className={lbl}>Fournisseur * {scan.supplierMatch && <Badge tone="green">reconnu ({scan.supplierMatch.by === 'tax_id' ? 'matricule fiscal' : 'nom'})</Badge>}</label>
              <select id="sc-sup" className={field} value={form.supplierId} onChange={(e) => setF('supplierId', e.target.value)}><option value="">— choisir —</option>{suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
              {!form.supplierId && scan.extraction.supplier?.name && <button type="button" className="mt-1 text-sm text-brand-700 underline" onClick={createSupplier}>Créer le fournisseur « {scan.extraction.supplier.name} »</button>}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div><label htmlFor="sc-ref" className={lbl}>N° de facture fournisseur *</label><input id="sc-ref" className={field} value={form.supplierRef} onChange={(e) => setF('supplierRef', e.target.value)} /></div>
              <div><label htmlFor="sc-cur" className={lbl}>Devise</label><input id="sc-cur" className={field} value={form.currency} maxLength={3} onChange={(e) => setF('currency', e.target.value.toUpperCase())} /></div>
              <div><label htmlFor="sc-date" className={lbl}>Date *</label><input id="sc-date" type="date" className={field} value={form.issueDate} onChange={(e) => setF('issueDate', e.target.value)} /></div>
              <div><label htmlFor="sc-due" className={lbl}>Échéance</label><input id="sc-due" type="date" className={field} value={form.dueDate} onChange={(e) => setF('dueDate', e.target.value)} /></div>
            </div>
            <div>
              <p className={lbl}>Lignes (prix unitaires HT) *</p>
              <div className="space-y-2">{form.lines.map((l, i) => (
                <div key={i} className="grid grid-cols-12 gap-2">
                  <input aria-label={`Description ligne ${i + 1}`} className={`${field} col-span-12 sm:col-span-5`} value={l.description} onChange={(e) => setLine(i, 'description', e.target.value)} placeholder="Description" />
                  <input aria-label={`Quantité ligne ${i + 1}`} className={`${field} col-span-3 sm:col-span-2`} inputMode="decimal" value={l.quantity} onChange={(e) => setLine(i, 'quantity', e.target.value)} />
                  <input aria-label={`Prix HT ligne ${i + 1}`} className={`${field} col-span-4 sm:col-span-2`} inputMode="decimal" value={l.unitPrice} onChange={(e) => setLine(i, 'unitPrice', e.target.value)} />
                  <select aria-label={`TVA ligne ${i + 1}`} className={`${field} col-span-4 sm:col-span-2`} value={l.taxRateId} onChange={(e) => setLine(i, 'taxRateId', e.target.value)}><option value="">TVA ?</option>{taxRates.map((t) => <option key={t.id} value={t.id}>{Number(t.rate)} %</option>)}</select>
                  <button type="button" aria-label={`Supprimer la ligne ${i + 1}`} className="col-span-1 text-slate-400 hover:text-red-600" onClick={() => setForm((f) => ({ ...f, lines: f.lines.filter((_, j) => j !== i) }))}><Trash2 size={16} /></button>
                </div>))}</div>
              <button type="button" className="mt-2 inline-flex items-center gap-1 text-sm text-brand-700" onClick={() => setForm((f) => ({ ...f, lines: [...f.lines, { description: '', quantity: '1', unitPrice: '', discountPct: '0', taxRateId: '' }] }))}><Plus size={14} aria-hidden /> Ajouter une ligne</button>
            </div>
            <div className="flex flex-wrap items-center gap-3 text-sm"><label className="flex items-center gap-2"><input id="scan-stamp" type="checkbox" className="h-4 w-4" checked={!!form.stampOn} onChange={(e) => setF('stampOn', e.target.checked)} />Timbre fiscal sur ce document <span className="text-slate-500">(facultatif)</span></label>
              {form.stampOn && <input aria-label="Montant du timbre" className={`${field} w-32`} inputMode="decimal" placeholder="Montant" value={form.stampAmount} onChange={(e) => setF('stampAmount', e.target.value)} />}</div>
            {scan.extraction.totals?.totalInclTax != null && <p className="text-xs text-slate-500">Total TTC lu sur le document : {Number(scan.extraction.totals.totalInclTax).toFixed(3)} — comparé automatiquement au total recalculé par MHFac.</p>}
            <div className="flex justify-between gap-2"><Button type="button" variant="secondary" onClick={discard}>Abandonner</Button><Button type="button" loading={busy} disabled={!ready || scan.extraction.documentType === 'credit_note'} onClick={submit}>Créer le brouillon</Button></div>
          </Card>
        </div>
      )}
    </>
  );
}
