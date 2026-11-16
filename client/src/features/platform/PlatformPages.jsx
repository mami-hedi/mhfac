import { useCallback, useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { Building2, Plus } from 'lucide-react';
import { api, errorMessage } from '../../services/api.js';
import { Alert, Badge, Button, Card, EmptyState, Modal, PageHeader, Spinner } from '../../components/ui/index.jsx';
import { fmtDate } from '../sales/shared.jsx';
import { fmtLimit, fmtPrice, fmtPriceYearly } from '../subscription/SubscriptionPage.jsx';

const field = 'block w-full rounded-md border border-slate-300 px-3 py-2 text-sm';
const lbl = 'mb-1 block text-sm font-medium text-slate-700';
const SUB = { trial: ['Essai', 'blue'], active: ['Actif', 'green'], past_due: ['Retard', 'orange'], cancelled: ['Annulé', 'red'], expired: ['Expiré', 'red'] };
const LIMITS = { users: 'Utilisateurs', invoicesPerMonth: 'Factures / mois', warehouses: 'Entrepôts', scansPerMonth: 'Scans / mois', exportsPerMonth: 'Exports / mois' };
const FEATS = { einvoice: 'Facturation électronique', purchaseScan: 'Scan de factures', reportsExport: 'Export des rapports' };

export function PlatformHome() {
  const [d, setD] = useState(null); const [error, setError] = useState('');
  useEffect(() => { api.get('/platform/overview').then((r) => setD(r.data.data)).catch((e) => setError(errorMessage(e))); }, []);
  if (error) return <Alert tone="error">{error}</Alert>;
  if (!d) return <Spinner />;
  const kpi = [['Entreprises', d.companies], ['Suspendues', d.suspendedCompanies], ['Utilisateurs actifs', d.activeUsers], ['Factures émises (total)', d.invoicesIssued], ['Nouvelles (30 j)', d.newCompanies30d], ['Paiements à vérifier', d.pendingPayments], ['Abonnements expirés', d.expiredSubscriptions]];
  return (
    <>
      <PageHeader title="Plateforme MHFac" subtitle="Espace super administrateur : entreprises, offres et abonnements. Les données métier des entreprises ne sont pas accessibles ici." />
      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-7">{kpi.map(([l, v]) => <Card key={l} className="p-4"><p className="text-xs uppercase text-slate-500">{l}</p><p className="text-2xl font-semibold tabular-nums">{v}</p></Card>)}</div>
      <div className="mb-4 grid gap-4 lg:grid-cols-2">
        <Card className="p-5"><div className="mb-2 flex items-center justify-between"><h2 className="text-sm font-semibold">Virements à vérifier</h2><Link className="text-xs underline" to="/platform/payments">Tout voir</Link></div>
          {d.toProcess.payments.length === 0 ? <p className="text-sm text-slate-500">Aucun virement en attente.</p> : (
            <ul className="divide-y divide-slate-100 text-sm">{d.toProcess.payments.slice(0, 8).map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-3 py-2"><div><Link className="font-medium text-brand-700 hover:underline" to={`/platform/companies/${p.company.id}`}>{p.company.name}</Link>
                <p className="text-xs text-slate-500">{p.plan} · {p.period === 'yearly' ? 'annuel' : 'mensuel'} · réf. {p.reference} · le {fmtDate(p.paidOn)}</p></div>
                <span className="whitespace-nowrap tabular-nums">{p.amount} {p.currency}</span></li>))}</ul>)}
          <p className="mt-2 text-xs text-slate-500">Vérifiez votre relevé bancaire, puis validez (l'offre est activée et l'échéance fixée) ou rejetez avec un motif.</p></Card>
        <Card className="p-5"><div className="mb-2 flex items-center justify-between"><h2 className="text-sm font-semibold">Échéances proches ou dépassées</h2><Link className="text-xs underline" to="/platform/companies?subscription=expiring">Voir la liste</Link></div>
          {d.toProcess.dueSoon.length === 0 ? <p className="text-sm text-slate-500">Aucune échéance dans les 7 prochains jours.</p> : (
            <ul className="divide-y divide-slate-100 text-sm">{d.toProcess.dueSoon.slice(0, 8).map((x) => (
              <li key={x.company.id} className="flex items-center justify-between gap-3 py-2"><div><Link className="font-medium text-brand-700 hover:underline" to={`/platform/companies/${x.company.id}`}>{x.company.name}</Link><p className="text-xs text-slate-500">{x.plan} · {SUB[x.status]?.[0] ?? x.status}</p></div>
                <span className="whitespace-nowrap"><Badge tone={x.expired ? 'red' : 'orange'}>{x.expired ? 'Expiré le ' : 'Échéance le '}{fmtDate(String(new Date(x.dueDate).toISOString()).slice(0, 10))}</Badge></span></li>))}</ul>)}</Card>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="p-5"><h2 className="mb-2 text-sm font-semibold">Entreprises par offre</h2><ul className="space-y-1 text-sm">{d.byPlan.map((p) => <li key={p.code} className="flex justify-between"><span>{p.name}</span><span className="tabular-nums">{p.count}</span></li>)}</ul></Card>
        <Card className="p-5"><h2 className="mb-2 text-sm font-semibold">État</h2><p className="text-sm">Base de données : <Badge tone="green">{d.health.database === 'up' ? 'opérationnelle' : d.health.database}</Badge> · {d.health.tables} tables</p>
          <ul className="mt-2 space-y-1 text-sm text-slate-600">{Object.entries(d.bySubscriptionStatus).map(([k, v]) => <li key={k} className="flex justify-between"><span>{SUB[k]?.[0] ?? k}</span><span className="tabular-nums">{v}</span></li>)}</ul></Card>
      </div>
      <div className="mt-4 flex gap-3 text-sm"><Link className="underline" to="/platform/companies">Gérer les entreprises</Link><Link className="underline" to="/platform/plans">Gérer les offres</Link></div>
    </>
  );
}

export function PlatformCompanies() {
  const [state, setState] = useState({ loading: true }); const [q, setQ] = useState(''); const [status, setStatus] = useState(''); const [sp, setSp] = useSearchParams(); const subscription = sp.get('subscription') ?? '';
  const load = useCallback(async () => { try { setState({ ...(await api.get('/platform/companies', { params: { q: q || undefined, status: status || undefined, subscription: subscription || undefined, limit: 100 } })).data }); } catch (e) { setState({ error: errorMessage(e) }); } }, [q, status, subscription]);
  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t); }, [load]);
  return (
    <>
      <PageHeader title="Entreprises" subtitle="Toutes les entreprises de la plateforme." />
      <div className="mb-3 flex flex-wrap gap-2"><input aria-label="Rechercher" className={`${field} max-w-xs`} placeholder="Nom ou matricule fiscal" value={q} onChange={(e) => setQ(e.target.value)} />
        <select aria-label="Statut" className={`${field} max-w-[11rem]`} value={status} onChange={(e) => setStatus(e.target.value)}><option value="">Tous les statuts</option><option value="active">Actives</option><option value="suspended">Suspendues</option></select>
        <select aria-label="Abonnement" className={`${field} max-w-[13rem]`} value={subscription} onChange={(e) => setSp(e.target.value ? { subscription: e.target.value } : {})}><option value="">Tous les abonnements</option><option value="trial">En essai</option><option value="active">Actifs (payés)</option><option value="expiring">Échéance sous 7 jours</option><option value="expired">Expirés (lecture seule)</option><option value="past_due">En retard</option><option value="cancelled">Annulés</option></select></div>
      <Card>{state.loading ? <Spinner /> : state.error ? <div className="p-4"><Alert tone="error">{state.error}</Alert></div> : state.data.length === 0 ? <EmptyState icon={Building2} title="Aucune entreprise" /> : (
        <div className="overflow-x-auto"><table className="w-full min-w-[720px] text-left text-sm"><thead className="bg-slate-50 text-xs uppercase text-slate-500"><tr><th className="px-4 py-2">Entreprise</th><th className="px-4 py-2">Propriétaire</th><th className="px-4 py-2">Offre</th><th className="px-4 py-2">Abonnement</th><th className="px-4 py-2">Échéance (essai ou paiement)</th><th className="px-4 py-2">Créée le</th></tr></thead>
          <tbody className="divide-y divide-slate-100">{state.data.map((c) => (
            <tr key={c.id}><td className="px-4 py-2"><Link className="font-medium text-brand-700 hover:underline" to={`/platform/companies/${c.id}`}>{c.name}</Link>{c.status === 'suspended' && <> <Badge tone="red">Suspendue</Badge></>}</td>
              <td className="px-4 py-2 text-slate-600">{c.ownerEmail}</td><td className="px-4 py-2">{c.plan?.name ?? '—'}</td>
              <td className="px-4 py-2">{c.effectiveStatus ? <Badge tone={SUB[c.effectiveStatus]?.[1]}>{SUB[c.effectiveStatus]?.[0] ?? c.effectiveStatus}</Badge> : '—'}</td>
              <td className="px-4 py-2">{c.dueDate ? fmtDate(new Date(c.dueDate).toISOString().slice(0, 10)) : '—'}</td><td className="px-4 py-2">{fmtDate(new Date(c.createdAt).toISOString().slice(0, 10))}</td></tr>))}</tbody></table></div>)}</Card>
      {state.meta && <p className="mt-2 text-xs text-slate-500">{state.meta.total} entreprise(s)</p>}
    </>
  );
}

export function PlatformCompany() {
  const { id } = useParams(); const [d, setD] = useState(null); const [plans, setPlans] = useState([]); const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const [f, setF] = useState(null); const [busy, setBusy] = useState(false); const [susp, setSusp] = useState(null); const [reason, setReason] = useState('');
  const load = useCallback(async () => {
    try { const [a, p] = await Promise.all([api.get(`/platform/companies/${id}`), api.get('/platform/plans')]); setD(a.data.data); setPlans(p.data.data);
      const s = a.data.data.subscription; setF({ planCode: s.plan.code, status: s.status, trialEndsAt: (s.trialEndsAt ?? '').slice(0, 10), currentPeriodEnd: (s.currentPeriodEnd ?? '').slice(0, 10), billingPeriod: s.billingPeriod ?? '', notes: a.data.data.notes ?? '' }); }
    catch (e) { setError(errorMessage(e)); }
  }, [id]);
  useEffect(() => { load(); }, [load]);
  const save = async () => { setBusy(true); setError(''); try { await api.put(`/platform/companies/${id}/subscription`, { ...f, trialEndsAt: f.trialEndsAt || null, currentPeriodEnd: f.currentPeriodEnd || null, billingPeriod: f.billingPeriod || null, notes: f.notes || null }); setNotice('Abonnement mis à jour'); await load(); } catch (e) { setError(errorMessage(e)); } setBusy(false); };
  const toggle = async () => { setBusy(true); try { await api.post(`/platform/companies/${id}/${susp}`, { reason }); setSusp(null); setReason(''); setNotice(susp === 'suspend' ? 'Entreprise suspendue' : 'Entreprise réactivée'); await load(); } catch (e) { setError(errorMessage(e)); } setBusy(false); };
  if (!d || !f) return error ? <Alert tone="error">{error}</Alert> : <Spinner />;
  const s = d.subscription;
  return (
    <>
      <PageHeader title={d.name} subtitle={<span className="inline-flex items-center gap-2">{d.ownerEmail}{d.status === 'suspended' ? <Badge tone="red">Suspendue</Badge> : <Badge tone="green">Active</Badge>}</span>}
        actions={<Button variant="secondary" onClick={() => setSusp(d.status === 'suspended' ? 'reactivate' : 'suspend')}>{d.status === 'suspended' ? 'Réactiver' : 'Suspendre'}</Button>} />
      <div className="mb-4 space-y-2"><Alert tone="error">{error}</Alert><Alert tone="success" onClose={() => setNotice('')}>{notice}</Alert></div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="space-y-3 p-5"><h2 className="text-sm font-semibold">Abonnement</h2>
          <div><label htmlFor="pc-plan" className={lbl}>Offre</label><select id="pc-plan" className={field} value={f.planCode} onChange={(e) => setF({ ...f, planCode: e.target.value })}>{plans.map((p) => <option key={p.code} value={p.code} disabled={!p.isActive && p.code !== s.plan.code}>{p.name}{p.isActive ? '' : ' (inactive)'}</option>)}</select></div>
          <div><label htmlFor="pc-st" className={lbl}>Statut</label><select id="pc-st" className={field} value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}><option value="active">Actif</option><option value="trial">Essai</option><option value="past_due">Paiement en retard</option><option value="cancelled">Annulé (lecture seule)</option></select></div>
          <div className="grid grid-cols-2 gap-3"><div><label htmlFor="pc-tr" className={lbl}>Fin d'essai</label><input id="pc-tr" type="date" className={field} value={f.trialEndsAt} onChange={(e) => setF({ ...f, trialEndsAt: e.target.value })} /></div>
            <div><label htmlFor="pc-pe" className={lbl}>Échéance</label><input id="pc-pe" type="date" className={field} value={f.currentPeriodEnd} onChange={(e) => setF({ ...f, currentPeriodEnd: e.target.value })} /></div></div>
          <div><label htmlFor="pc-bp" className={lbl}>Périodicité convenue</label><select id="pc-bp" className={field} value={f.billingPeriod} onChange={(e) => setF({ ...f, billingPeriod: e.target.value })}><option value="">Non précisée</option><option value="monthly">Mensuelle</option><option value="yearly">Annuelle</option></select></div>
          <p className="text-xs text-slate-500">Après l'échéance (ou la fin d'essai), l'entreprise passe en lecture seule. Laissez vide pour « sans échéance ». Aucun paiement en ligne : le règlement est suivi hors de MHFac.</p>
          <div><label htmlFor="pc-nt" className={lbl}>Notes internes</label><textarea id="pc-nt" rows={2} maxLength={500} className={field} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></div>
          <div className="flex justify-end"><Button loading={busy} onClick={save}>Enregistrer</Button></div></Card>
        <Card className="p-5"><h2 className="mb-3 text-sm font-semibold">Consommation ({s.plan.name})</h2>
          <ul className="space-y-1 text-sm">{Object.entries(s.limits).map(([k, max]) => <li key={k} className="flex justify-between"><span>{LIMITS[k]}</span><span className="tabular-nums">{s.usage[k]} / {fmtLimit(max)}</span></li>)}</ul>
          <h2 className="mb-2 mt-5 text-sm font-semibold">Membres</h2><ul className="space-y-1 text-sm">{d.members.map((m) => <li key={m.email} className="flex justify-between"><span>{m.email}</span><span className="text-slate-500">{m.role} · {m.status}</span></li>)}</ul></Card>
      </div>
      <Card className="mt-4 p-5"><h2 className="mb-2 text-sm font-semibold">Historique</h2>{d.history.length === 0 ? <p className="text-sm text-slate-500">Aucun événement.</p> : <ul className="space-y-1 text-sm">{d.history.map((h, i) => <li key={i}><span className="text-slate-500">{new Date(h.at).toLocaleString('fr-FR')}</span> — {h.event}{h.detail?.to ? ` : ${h.detail.from?.plan} → ${h.detail.to.plan} (${h.detail.to.status})` : h.detail?.reason ? ` : ${h.detail.reason}` : ''} <span className="text-slate-400">{h.by}</span></li>)}</ul>}</Card>
      {susp && <Modal title={susp === 'suspend' ? 'Suspendre l\'entreprise' : 'Réactiver l\'entreprise'} onClose={() => setSusp(null)}><div className="space-y-3">
        {susp === 'suspend' && <Alert tone="info">Tous les utilisateurs de cette entreprise perdront l'accès immédiatement. Aucune donnée n'est supprimée.</Alert>}
        <div><label htmlFor="su-r" className={lbl}>Motif *</label><input id="su-r" className={field} value={reason} onChange={(e) => setReason(e.target.value)} /></div>
        <div className="flex justify-end gap-2"><Button variant="secondary" onClick={() => setSusp(null)}>Annuler</Button><Button loading={busy} disabled={reason.trim().length < 5} onClick={toggle}>Confirmer</Button></div></div></Modal>}
    </>
  );
}

const emptyPlan = { code: '', name: '', description: '', priceMonthly: '', priceYearly: '', currency: 'TND', limits: { users: '1', invoicesPerMonth: '10', warehouses: '1', scansPerMonth: '5', exportsPerMonth: '5' }, features: { einvoice: false, purchaseScan: true, reportsExport: false, support: '' }, isActive: true, isPublic: true, sortOrder: 0 };
export function PlatformPlans() {
  const [plans, setPlans] = useState(null); const [error, setError] = useState(''); const [edit, setEdit] = useState(null); const [busy, setBusy] = useState(false);
  const load = useCallback(async () => { try { setPlans((await api.get('/platform/plans')).data.data); } catch (e) { setError(errorMessage(e)); } }, []);
  useEffect(() => { load(); }, [load]);
  const open = (p) => setEdit(p ? { ...p, isNew: false, priceMonthly: p.priceMonthly ?? '', priceYearly: p.priceYearly ?? '', description: p.description ?? '', limits: Object.fromEntries(Object.entries(p.limits).map(([k, v]) => [k, v == null ? '' : String(v)])), features: { ...p.features, support: p.features.support ?? '' } } : { ...emptyPlan, isNew: true });
  const save = async () => {
    setBusy(true); setError('');
    const body = { name: edit.name, description: edit.description || null, priceMonthly: edit.priceMonthly === '' ? null : edit.priceMonthly, priceYearly: edit.priceYearly === '' ? null : edit.priceYearly, currency: edit.currency, isActive: edit.isActive, isPublic: edit.isPublic, sortOrder: Number(edit.sortOrder) || 0,
      limits: Object.fromEntries(Object.entries(edit.limits).map(([k, v]) => [k, v === '' ? null : Number(v)])), features: { einvoice: !!edit.features.einvoice, purchaseScan: !!edit.features.purchaseScan, reportsExport: !!edit.features.reportsExport, ...(edit.features.support ? { support: edit.features.support } : {}) } };
    try { if (edit.isNew) await api.post('/platform/plans', { ...body, code: edit.code }); else await api.put(`/platform/plans/${edit.id}`, body); setEdit(null); await load(); } catch (e) { setError(errorMessage(e)); }
    setBusy(false);
  };
  if (!plans) return error ? <Alert tone="error">{error}</Alert> : <Spinner />;
  return (
    <>
      <PageHeader title="Offres d'abonnement" subtitle="Limites et prix entièrement configurables : rien n'est figé dans le code. Un champ de limite vide = illimité ; un prix vide = « sur demande »." actions={<Button onClick={() => open(null)}><Plus size={16} aria-hidden /> Nouvelle offre</Button>} />
      <div className="mb-3"><Alert tone="error">{error}</Alert></div>
      <Card><div className="overflow-x-auto"><table className="w-full min-w-[820px] text-left text-sm"><thead className="bg-slate-50 text-xs uppercase text-slate-500"><tr><th className="px-4 py-2">Offre</th><th className="px-4 py-2">Prix</th>{Object.values(LIMITS).map((l) => <th key={l} className="px-3 py-2">{l}</th>)}<th className="px-4 py-2">Entreprises</th><th /></tr></thead>
        <tbody className="divide-y divide-slate-100">{plans.map((p) => (
          <tr key={p.id}><td className="px-4 py-2 font-medium">{p.name} <span className="text-xs text-slate-400">{p.code}</span>{!p.isActive && <> <Badge tone="neutral">Inactive</Badge></>}</td><td className="px-4 py-2">{fmtPrice(p)}{fmtPriceYearly(p) && <span className="block text-xs text-slate-500">{fmtPriceYearly(p)}</span>}</td>
            {Object.keys(LIMITS).map((k) => <td key={k} className="px-3 py-2 tabular-nums">{fmtLimit(p.limits[k])}</td>)}<td className="px-4 py-2 tabular-nums">{p.companies}</td>
            <td className="px-4 py-2 text-right"><Button variant="secondary" onClick={() => open(p)}>Modifier</Button></td></tr>))}</tbody></table></div></Card>
      {edit && <Modal title={edit.isNew ? 'Nouvelle offre' : `Modifier « ${edit.name} »`} onClose={() => setEdit(null)}><div className="space-y-3">
        <Alert tone="error">{error}</Alert>
        {edit.isNew && <div><label htmlFor="pl-code" className={lbl}>Code * (minuscules, chiffres, _)</label><input id="pl-code" className={field} value={edit.code} onChange={(e) => setEdit({ ...edit, code: e.target.value.toLowerCase() })} /></div>}
        <div className="grid grid-cols-3 gap-3"><div><label htmlFor="pl-name" className={lbl}>Nom *</label><input id="pl-name" className={field} value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></div>
          <div><label htmlFor="pl-price" className={lbl}>Prix mensuel ({edit.currency})</label><input id="pl-price" inputMode="decimal" className={field} placeholder="vide = sur demande" value={edit.priceMonthly} onChange={(e) => setEdit({ ...edit, priceMonthly: e.target.value })} /></div>
          <div><label htmlFor="pl-priceY" className={lbl}>Prix annuel ({edit.currency})</label><input id="pl-priceY" inputMode="decimal" className={field} placeholder="vide = pas de tarif annuel" value={edit.priceYearly} onChange={(e) => setEdit({ ...edit, priceYearly: e.target.value })} /></div></div>
        <div><label htmlFor="pl-desc" className={lbl}>Description</label><input id="pl-desc" className={field} value={edit.description} onChange={(e) => setEdit({ ...edit, description: e.target.value })} /></div>
        <p className={lbl}>Limites (vide = illimité)</p>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">{Object.entries(LIMITS).map(([k, l]) => <div key={k}><label htmlFor={`pl-${k}`} className="mb-1 block text-xs text-slate-600">{l}</label><input id={`pl-${k}`} inputMode="numeric" className={field} value={edit.limits[k]} onChange={(e) => setEdit({ ...edit, limits: { ...edit.limits, [k]: e.target.value.replace(/\D/g, '') } })} /></div>)}</div>
        <p className={lbl}>Fonctionnalités</p>
        <div className="space-y-1">{Object.entries(FEATS).map(([k, l]) => <label key={k} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={!!edit.features[k]} onChange={(e) => setEdit({ ...edit, features: { ...edit.features, [k]: e.target.checked } })} /> {l}</label>)}</div>
        <div><label htmlFor="pl-sup" className={lbl}>Niveau de support (texte affiché)</label><input id="pl-sup" className={field} value={edit.features.support} onChange={(e) => setEdit({ ...edit, features: { ...edit.features, support: e.target.value } })} /></div>
        <div className="flex gap-4 text-sm"><label className="flex items-center gap-2"><input type="checkbox" checked={edit.isActive} onChange={(e) => setEdit({ ...edit, isActive: e.target.checked })} /> Attribuable</label><label className="flex items-center gap-2"><input type="checkbox" checked={edit.isPublic} onChange={(e) => setEdit({ ...edit, isPublic: e.target.checked })} /> Visible par les entreprises</label></div>
        <div className="flex justify-end gap-2"><Button variant="secondary" onClick={() => setEdit(null)}>Annuler</Button><Button loading={busy} disabled={!edit.name.trim() || (edit.isNew && edit.code.length < 2)} onClick={save}>Enregistrer</Button></div></div></Modal>}
    </>
  );
}

// --- Paiements par virement : coordonnées bancaires de l'éditeur + vérification des déclarations des clients ---
const PAY_ST = { pending: ['À vérifier', 'orange'], confirmed: ['Confirmé', 'green'], rejected: ['Rejeté', 'red'] };
const emptyBank = { beneficiary: '', bankName: '', rib: '', iban: '', bic: '', contactEmail: '', contactPhone: '', instructions: '' };
export function PlatformPayments() {
  const [bank, setBank] = useState(null); const [configured, setConfigured] = useState(true); const [list, setList] = useState(null); const [status, setStatus] = useState('pending');
  const [error, setError] = useState(''); const [notice, setNotice] = useState(''); const [busy, setBusy] = useState(false); const [act, setAct] = useState(null); const [val, setVal] = useState('');
  const load = useCallback(async () => {
    try { const [a, b] = await Promise.all([api.get('/platform/payment-info'), api.get(`/platform/payments${status ? `?status=${status}` : ''}`)]);
      // jamais de pré-remplissage avec les valeurs de remplacement
      const d = a.data.data; setConfigured(d.configured); setBank(d.configured ? Object.fromEntries(Object.keys(emptyBank).map((k) => [k, d[k] ?? ''])) : emptyBank); setList(b.data.data); }
    catch (e) { setError(errorMessage(e)); }
  }, [status]);
  useEffect(() => { load(); }, [load]);
  const saveBank = async (e) => {
    e.preventDefault(); setBusy(true); setError(''); setNotice('');
    try { await api.put('/platform/payment-info', Object.fromEntries(Object.entries(bank).map(([k, v]) => [k, v === '' ? null : v]))); setNotice('Coordonnées bancaires enregistrées : elles sont désormais visibles par vos clients.'); await load(); }
    catch (err) { setError(errorMessage(err)); }
    setBusy(false);
  };
  const run = async () => {
    setBusy(true); setError('');
    try { if (act.kind === 'confirm') await api.post(`/platform/payments/${act.p.id}/confirm`, { receivedAmount: val }); else await api.post(`/platform/payments/${act.p.id}/reject`, { reason: val }); setAct(null); setVal(''); setNotice(act.kind === 'confirm' ? 'Paiement confirmé : abonnement activé.' : 'Paiement rejeté : le client a été prévenu par e-mail.'); await load(); }
    catch (err) { setError(errorMessage(err)); }
    setBusy(false);
  };
  if (!bank || !list) return error ? <Alert tone="error">{error}</Alert> : <Spinner />;
  const set = (k) => (e) => setBank({ ...bank, [k]: e.target.value });
  return (
    <>
      <PageHeader title="Paiements par virement" subtitle="Vos coordonnées bancaires et les virements déclarés par vos clients. Aucun paiement en ligne." />
      <div className="mb-4 space-y-2"><Alert tone="error" onClose={() => setError('')}>{error}</Alert><Alert tone="success" onClose={() => setNotice('')}>{notice}</Alert>
        {!configured && <Alert tone="info">Les coordonnées ci-dessous sont des <strong>valeurs de remplacement</strong>. Tant que vous ne les avez pas remplacées et enregistrées, vos clients ne voient aucune coordonnée bancaire et ne peuvent pas déclarer de paiement.</Alert>}</div>
      <Card className="mb-6 p-5"><h2 className="mb-3 text-sm font-semibold">Mes coordonnées bancaires {configured ? <Badge tone="green">Publiées</Badge> : <Badge tone="orange">À compléter</Badge>}</h2>
        <form onSubmit={saveBank} className="grid gap-3 md:grid-cols-2">
          <div><label htmlFor="bk-ben" className={lbl}>Bénéficiaire *</label><input id="bk-ben" className={field} required value={bank.beneficiary} onChange={set('beneficiary')} /></div>
          <div><label htmlFor="bk-bank" className={lbl}>Banque *</label><input id="bk-bank" className={field} required value={bank.bankName} onChange={set('bankName')} /></div>
          <div><label htmlFor="bk-rib" className={lbl}>RIB (20 chiffres) *</label><input id="bk-rib" className={field} required inputMode="numeric" placeholder="08 006 0110123456789 74" value={bank.rib} onChange={set('rib')} /></div>
          <div><label htmlFor="bk-iban" className={lbl}>IBAN</label><input id="bk-iban" className={field} placeholder="TN98 0800 …" value={bank.iban} onChange={set('iban')} /></div>
          <div><label htmlFor="bk-bic" className={lbl}>BIC / SWIFT</label><input id="bk-bic" className={field} placeholder="BXMPTNTT" value={bank.bic} onChange={set('bic')} /></div>
          <div><label htmlFor="bk-mail" className={lbl}>E-mail de contact</label><input id="bk-mail" type="email" className={field} value={bank.contactEmail} onChange={set('contactEmail')} /></div>
          <div><label htmlFor="bk-tel" className={lbl}>Téléphone de contact</label><input id="bk-tel" className={field} value={bank.contactPhone} onChange={set('contactPhone')} /></div>
          <div className="md:col-span-2"><label htmlFor="bk-ins" className={lbl}>Consignes affichées au client</label><textarea id="bk-ins" rows={2} maxLength={1000} className={field} value={bank.instructions} onChange={set('instructions')} /></div>
          <div className="md:col-span-2"><Button type="submit" loading={busy}>Enregistrer et publier</Button></div>
        </form></Card>
      <div className="mb-2 flex items-center gap-3"><h2 className="text-sm font-semibold">Déclarations de virement</h2>
        <select aria-label="Filtrer par statut" className="rounded-md border border-slate-300 px-2 py-1 text-sm" value={status} onChange={(e) => { setList(null); setStatus(e.target.value); }}><option value="pending">À vérifier</option><option value="confirmed">Confirmées</option><option value="rejected">Rejetées</option><option value="">Toutes</option></select></div>
      <Card>{list.length === 0 ? <p className="p-4 text-sm text-slate-500">Aucune déclaration.</p> : (
        <div className="overflow-x-auto"><table className="w-full min-w-[820px] text-left text-sm"><thead className="bg-slate-50 text-xs uppercase text-slate-500"><tr><th className="px-4 py-2">Entreprise</th><th className="px-4 py-2">Offre</th><th className="px-4 py-2">Périodicité</th><th className="px-4 py-2 text-right">Montant attendu</th><th className="px-4 py-2">Référence / date</th><th className="px-4 py-2">Statut</th><th /></tr></thead>
          <tbody className="divide-y divide-slate-100">{list.map((p) => (
            <tr key={p.id}><td className="px-4 py-2 font-medium"><Link to={`/platform/companies/${p.company.id}`} className="hover:underline">{p.company.name}</Link></td><td className="px-4 py-2">{p.plan.name}</td><td className="px-4 py-2">{p.period === 'yearly' ? 'Annuelle' : 'Mensuelle'}</td>
              <td className="px-4 py-2 text-right tabular-nums">{Number(p.amount).toLocaleString('fr-FR', { minimumFractionDigits: 3 })} {p.currency}</td><td className="px-4 py-2">{p.reference}<span className="block text-xs text-slate-500">{fmtDate(p.paidOn)}{p.note ? ` · ${p.note}` : ''}</span></td>
              <td className="px-4 py-2"><Badge tone={PAY_ST[p.status][1]}>{PAY_ST[p.status][0]}</Badge>{p.reviewNote && <span className="block text-xs text-slate-500">{p.reviewNote}</span>}</td>
              <td className="px-4 py-2 text-right">{p.status === 'pending' && <div className="flex justify-end gap-2"><Button onClick={() => { setAct({ kind: 'confirm', p }); setVal(''); }}>Confirmer</Button><Button variant="secondary" onClick={() => { setAct({ kind: 'reject', p }); setVal(''); }}>Rejeter</Button></div>}</td></tr>))}</tbody></table></div>)}</Card>
      {act && <Modal title={act.kind === 'confirm' ? `Confirmer le paiement de ${act.p.company.name}` : `Rejeter la déclaration de ${act.p.company.name}`} onClose={() => setAct(null)}><div className="space-y-3">
        <Alert tone="error">{error}</Alert>
        {act.kind === 'confirm'
          ? <><p className="text-sm text-slate-600">Vérifiez d'abord le virement sur votre relevé bancaire (référence « {act.p.reference} »). Saisissez le montant réellement reçu : il doit correspondre au montant attendu, {Number(act.p.amount).toLocaleString('fr-FR', { minimumFractionDigits: 3 })} {act.p.currency}. L'abonnement est alors activé et l'échéance calculée.</p>
            <div><label htmlFor="pay-recv" className={lbl}>Montant reçu ({act.p.currency}) *</label><input id="pay-recv" inputMode="decimal" className={field} value={val} onChange={(e) => setVal(e.target.value)} /></div></>
          : <div><label htmlFor="pay-reason" className={lbl}>Motif (envoyé au client) *</label><input id="pay-reason" className={field} minLength={5} maxLength={500} value={val} onChange={(e) => setVal(e.target.value)} /></div>}
        <div className="flex justify-end gap-2"><Button variant="secondary" onClick={() => setAct(null)}>Annuler</Button><Button loading={busy} disabled={!val.trim()} onClick={run}>{act.kind === 'confirm' ? 'Confirmer et activer' : 'Rejeter'}</Button></div>
      </div></Modal>}
    </>
  );
}
