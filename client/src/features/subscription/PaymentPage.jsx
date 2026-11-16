// « Payer mon abonnement » : paiement par VIREMENT BANCAIRE (aucun paiement en ligne).
// Le montant et l'offre sont calculés par le serveur ; le client ne peut que choisir la périodicité et déclarer son virement.
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Copy, Check } from 'lucide-react';
import { api, errorMessage } from '../../services/api.js';
import { Alert, Badge, Button, Card, PageHeader, Spinner } from '../../components/ui/index.jsx';
import { fmtDate } from '../sales/shared.jsx';

const field = 'block w-full rounded-md border border-slate-300 px-3 py-2 text-sm';
const lbl = 'mb-1 block text-sm font-medium text-slate-700';
const PERIOD = { monthly: 'Mensuel', yearly: 'Annuel' };
const ST = { pending: ['En attente de vérification', 'orange'], confirmed: ['Confirmé', 'green'], rejected: ['Rejeté', 'red'] };
const money = (v, cur) => `${Number(v).toLocaleString('fr-FR', { minimumFractionDigits: Number(v) % 1 ? 3 : 0, maximumFractionDigits: 3 })} ${cur}`;
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Tunis' }).format(new Date());

function CopyRow({ label, value }) {
  const [done, setDone] = useState(false);
  if (!value) return null;
  const copy = async () => { try { await navigator.clipboard.writeText(value); setDone(true); setTimeout(() => setDone(false), 1500); } catch { /* presse-papiers indisponible : la valeur reste affichée */ } };
  return (
    <div className="flex items-center justify-between gap-3 border-b border-slate-100 py-2 last:border-0">
      <div className="min-w-0"><p className="text-xs uppercase text-slate-500">{label}</p><p className="break-all font-medium tabular-nums">{value}</p></div>
      <button type="button" onClick={copy} className="shrink-0 rounded p-2 text-slate-500 hover:bg-slate-100" aria-label={`Copier ${label}`}>{done ? <Check size={16} className="text-green-600" /> : <Copy size={16} />}</button>
    </div>
  );
}

export default function PaymentPage() {
  const [info, setInfo] = useState(null); const [list, setList] = useState([]); const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const [f, setF] = useState({ period: 'yearly', reference: '', paidOn: today(), note: '' }); const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try { const [a, b] = await Promise.all([api.get('/subscription/payment-info'), api.get('/subscription/payments')]); setInfo(a.data.data); setList(b.data.data); setF((x) => ({ ...x, period: a.data.data.options.some((o) => o.period === x.period) ? x.period : a.data.data.options[0]?.period ?? 'monthly' })); }
    catch (e) { setError(errorMessage(e)); }
  }, []);
  useEffect(() => { load(); }, [load]);
  const submit = async (e) => {
    e.preventDefault(); setBusy(true); setError(''); setNotice('');
    try { await api.post('/subscription/payments', { period: f.period, reference: f.reference, paidOn: f.paidOn, note: f.note || null }); setNotice('Déclaration envoyée. Votre abonnement sera activé dès la vérification de votre virement.'); setF({ ...f, reference: '', note: '' }); await load(); }
    catch (err) { setError(errorMessage(err)); }
    setBusy(false);
  };
  if (!info) return error ? <Alert tone="error">{error}</Alert> : <Spinner />;
  const chosen = info.options.find((o) => o.period === f.period);
  return (
    <>
      <PageHeader title="Payer mon abonnement" subtitle={`Offre ${info.plan.name} — paiement par virement bancaire.`} actions={<Link to="/subscription" className="text-sm font-medium text-brand-600 hover:underline">← Mon abonnement</Link>} />
      <div className="mb-4 space-y-2"><Alert tone="info">Aucun paiement en ligne : vous effectuez un virement depuis votre banque, puis vous le déclarez ici. L'abonnement est activé après vérification par notre équipe.</Alert><Alert tone="error" onClose={() => setError('')}>{error}</Alert><Alert tone="success" onClose={() => setNotice('')}>{notice}</Alert></div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="p-5"><h2 className="mb-3 text-sm font-semibold">1. Effectuez le virement</h2>
          {info.options.length === 0 ? <Alert tone="info">Aucun tarif n'est défini pour votre offre : contactez l'éditeur.</Alert> : (
            <div className="mb-4 grid gap-2 sm:grid-cols-2">{info.options.map((o) => (
              <label key={o.period} className={`cursor-pointer rounded-lg border p-3 ${f.period === o.period ? 'border-brand-600 ring-1 ring-brand-600' : 'border-slate-200'}`}>
                <input type="radio" name="period" className="sr-only" checked={f.period === o.period} onChange={() => setF({ ...f, period: o.period })} />
                <span className="block text-sm font-semibold">{PERIOD[o.period]}</span><span className="block text-lg tabular-nums">{money(o.amount, info.currency)}</span>
                {o.monthsFree > 0 && <span className="text-xs text-green-700">{o.monthsFree.toLocaleString('fr-FR')} mois offerts</span>}
              </label>))}</div>)}
          {info.configured ? (
            <div className="text-sm">
              <CopyRow label="Bénéficiaire" value={info.bank.beneficiary} /><CopyRow label="Banque" value={info.bank.bankName} /><CopyRow label="RIB" value={info.bank.rib} /><CopyRow label="IBAN" value={info.bank.iban} /><CopyRow label="BIC / SWIFT" value={info.bank.bic} />
              {chosen && <CopyRow label="Montant à virer" value={money(chosen.amount, info.currency)} />}
              <CopyRow label="Référence à indiquer dans le libellé" value={info.transferReference} />
              {info.instructions && <p className="mt-3 text-slate-600">{info.instructions}</p>}
              {(info.contactEmail || info.contactPhone) && <p className="mt-2 text-slate-600">Une question ? {[info.contactEmail, info.contactPhone].filter(Boolean).join(' · ')}</p>}
            </div>
          ) : <Alert tone="info">Les coordonnées bancaires ne sont pas encore communiquées. Contactez l'éditeur pour obtenir les informations de paiement ; ne virez rien avant de les avoir reçues.</Alert>}
        </Card>
        <Card className="p-5"><h2 className="mb-3 text-sm font-semibold">2. Déclarez votre virement</h2>
          {info.hasPending ? <Alert tone="info">Un paiement est en attente de vérification. Vous pourrez en déclarer un autre une fois celui-ci traité.</Alert> : (
            <form onSubmit={submit} className="space-y-3">
              <div><label htmlFor="pay-ref" className={lbl}>Référence ou numéro du virement *</label><input id="pay-ref" className={field} required minLength={3} maxLength={60} value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} /></div>
              <div><label htmlFor="pay-date" className={lbl}>Date du virement *</label><input id="pay-date" type="date" className={field} required max={today()} value={f.paidOn} onChange={(e) => setF({ ...f, paidOn: e.target.value })} /></div>
              <div><label htmlFor="pay-note" className={lbl}>Remarque</label><input id="pay-note" className={field} maxLength={500} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></div>
              <Button type="submit" loading={busy} disabled={!info.configured || !chosen}>J'ai effectué le virement{chosen ? ` (${money(chosen.amount, info.currency)})` : ''}</Button>
            </form>)}
        </Card>
      </div>
      <h2 className="mb-2 mt-6 text-sm font-semibold">Mes déclarations</h2>
      <Card>{list.length === 0 ? <p className="p-4 text-sm text-slate-500">Aucune déclaration pour le moment.</p> : (
        <div className="overflow-x-auto"><table className="w-full min-w-[640px] text-left text-sm"><thead className="bg-slate-50 text-xs uppercase text-slate-500"><tr><th className="px-4 py-2">Date</th><th className="px-4 py-2">Périodicité</th><th className="px-4 py-2 text-right">Montant</th><th className="px-4 py-2">Référence</th><th className="px-4 py-2">Statut</th><th className="px-4 py-2">Nouvelle échéance</th></tr></thead>
          <tbody className="divide-y divide-slate-100">{list.map((p) => (
            <tr key={p.id}><td className="px-4 py-2">{fmtDate(p.paidOn)}</td><td className="px-4 py-2">{PERIOD[p.period]}</td><td className="px-4 py-2 text-right tabular-nums">{money(p.amount, p.currency)}</td><td className="px-4 py-2">{p.reference}</td>
              <td className="px-4 py-2"><Badge tone={ST[p.status][1]}>{ST[p.status][0]}</Badge>{p.status === 'rejected' && p.reviewNote && <span className="block text-xs text-slate-500">{p.reviewNote}</span>}</td><td className="px-4 py-2">{p.periodEnd ? fmtDate(p.periodEnd) : '—'}</td></tr>))}</tbody></table></div>)}</Card>
    </>
  );
}
