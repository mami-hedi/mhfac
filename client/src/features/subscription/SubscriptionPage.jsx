import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, X as XIcon } from 'lucide-react';
import { api, errorMessage } from '../../services/api.js';
import { Alert, Badge, Card, PageHeader, Spinner } from '../../components/ui/index.jsx';
import { fmtDate } from '../sales/shared.jsx';

const STATUS = { trial: ['Période d\'essai', 'blue'], active: ['Actif', 'green'], past_due: ['Paiement en retard', 'orange'], cancelled: ['Annulé', 'red'], expired: ['Expiré', 'red'] };
export const fmtLimit = (v) => (v === null || v === undefined ? 'Illimité' : Number(v).toLocaleString('fr-FR'));
const money = (v, cur) => `${Number(v).toLocaleString('fr-FR', { minimumFractionDigits: v % 1 ? 3 : 0, maximumFractionDigits: 3 })} ${cur}`;
export const fmtPrice = (p) => (p.priceMonthly == null ? 'Sur demande' : `${money(p.priceMonthly, p.currency)} / mois`);
export const fmtPriceYearly = (p) => (p.priceYearly == null ? null : `${money(p.priceYearly, p.currency)} / an${p.yearlyMonthsFree > 0 ? ` (${p.yearlyMonthsFree.toLocaleString('fr-FR')} mois offerts)` : ''}`);
const PERIOD = { monthly: 'Mensuelle', yearly: 'Annuelle' };

function Bar({ used, max }) {
  if (max == null) return <div className="h-2 rounded bg-slate-100"><div className="h-2 w-1/12 rounded bg-brand-500/40" /></div>;
  const pct = max === 0 ? 100 : Math.min(100, Math.round((used / max) * 100));
  return <div className="h-2 rounded bg-slate-100" role="progressbar" aria-valuenow={used} aria-valuemax={max}><div className={`h-2 rounded ${used > max ? 'bg-red-500' : pct >= 80 ? 'bg-orange-500' : 'bg-brand-600'}`} style={{ width: `${pct}%` }} /></div>;
}

export default function SubscriptionPage() {
  const [s, setS] = useState(null); const [plans, setPlans] = useState([]); const [meta, setMeta] = useState({}); const [error, setError] = useState('');
  useEffect(() => { (async () => { try { const [a, b] = await Promise.all([api.get('/subscription'), api.get('/subscription/plans')]); setS(a.data.data); setMeta(a.data.meta); setPlans(b.data.data); } catch (e) { setError(errorMessage(e)); } })(); }, []);
  if (error) return <Alert tone="error">{error}</Alert>;
  if (!s) return <Spinner />;
  const [label, tone] = STATUS[s.effectiveStatus] ?? [s.effectiveStatus, 'neutral'];
  return (
    <>
      <PageHeader title="Mon abonnement" subtitle="Offre, consommation et fonctionnalités incluses." />
      <div className="mb-4 space-y-2">
        {s.effectiveStatus === 'trial' && s.trialDaysLeft != null && <Alert tone="info">Essai gratuit : il vous reste <strong>{s.trialDaysLeft} jour{s.trialDaysLeft > 1 ? 's' : ''}</strong> (jusqu'au {fmtDate(String(s.trialEndsAt).slice(0, 10))}). Toutes les fonctionnalités de l'offre {s.plan.name} sont disponibles. À la fin, l'application passe en lecture seule tant que l'abonnement n'est pas activé. <Link to="/subscription/pay" className="font-semibold underline">Passer au paiement</Link></Alert>}
        {s.readOnly && <Alert tone="error">Votre abonnement est expiré ou annulé : l'application est en lecture seule (vous pouvez consulter et exporter vos données). <Link to="/subscription/pay" className="font-semibold underline">Payer pour réactiver</Link></Alert>}
        <Alert tone="info">{meta.note}</Alert>
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="p-5 lg:col-span-1">
          <p className="text-xs uppercase text-slate-500">Offre actuelle</p>
          <p className="mt-1 text-xl font-semibold">{s.plan.name}</p>
          <p className="text-sm text-slate-500">{s.plan.description}</p>
          <p className="mt-3 text-sm">{fmtPrice(s.plan)}</p>{fmtPriceYearly(s.plan) && <p className="text-sm text-slate-600">{fmtPriceYearly(s.plan)}</p>}
          <div className="mt-3 flex flex-wrap items-center gap-2"><Badge tone={tone}>{label}</Badge></div>
          <Link to="/subscription/pay" className="mt-3 inline-block rounded-md bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700">{s.effectiveStatus === 'active' ? 'Renouveler / payer' : 'Passer au paiement'}</Link>
          <dl className="mt-3 space-y-1 text-sm text-slate-600">
            {s.trialEndsAt && <div className="flex justify-between"><dt>Fin de l'essai</dt><dd>{fmtDate(String(s.trialEndsAt).slice(0, 10))}</dd></div>}
            <div className="flex justify-between"><dt>Échéance</dt><dd>{s.currentPeriodEnd ? fmtDate(String(s.currentPeriodEnd).slice(0, 10)) : 'Sans échéance'}</dd></div>
            {s.billingPeriod && <div className="flex justify-between"><dt>Périodicité</dt><dd>{PERIOD[s.billingPeriod]}</dd></div>}
            {s.features.support && <div className="flex justify-between"><dt>Support</dt><dd>{s.features.support}</dd></div>}
          </dl>
        </Card>
        <Card className="p-5 lg:col-span-2">
          <h2 className="mb-3 text-sm font-semibold">Consommation</h2>
          <div className="space-y-4">{Object.entries(s.limits).map(([k, max]) => (
            <div key={k}><div className="mb-1 flex justify-between text-sm"><span>{(meta.limitLabels?.[k] ?? k).replace(/^./, (c) => c.toUpperCase())}</span><span className="tabular-nums text-slate-600">{s.usage[k]} / {fmtLimit(max)}</span></div><Bar used={s.usage[k]} max={max} /></div>))}</div>
          <h2 className="mb-2 mt-6 text-sm font-semibold">Fonctionnalités</h2>
          <ul className="grid gap-1 text-sm sm:grid-cols-2">{Object.entries(meta.featureLabels ?? {}).map(([k, l]) => (
            <li key={k} className="flex items-center gap-2">{s.features[k] ? <Check size={16} className="text-green-600" aria-label="Incluse" /> : <XIcon size={16} className="text-slate-400" aria-label="Non incluse" />}<span className={s.features[k] ? '' : 'text-slate-400'}>{l}</span></li>))}</ul>
        </Card>
      </div>
      <h2 className="mb-2 mt-6 text-sm font-semibold">Offres disponibles</h2>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">{plans.map((p) => (
        <Card key={p.code} className={`p-4 ${p.code === s.plan.code ? 'ring-2 ring-brand-500' : ''}`}>
          <div className="flex items-center justify-between"><p className="font-semibold">{p.name}</p>{p.code === s.plan.code && <Badge tone="blue">Actuelle</Badge>}</div>
          <p className="text-sm text-slate-500">{p.description}</p><p className="mt-2 text-sm font-medium">{fmtPrice(p)}</p><p className="mb-2 text-xs text-slate-600">{fmtPriceYearly(p) ?? '\u00a0'}</p>
          <ul className="space-y-0.5 text-xs text-slate-600">{Object.entries(p.limits).map(([k, v]) => <li key={k}>{fmtLimit(v)} {meta.limitLabels?.[k] ?? k}</li>)}
            {Object.entries(meta.featureLabels ?? {}).map(([k, l]) => <li key={k} className={p.features[k] ? '' : 'text-slate-400 line-through'}>{l}</li>)}</ul>
        </Card>))}</div>
    </>
  );
}
