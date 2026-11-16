import { useCallback, useEffect, useState } from 'react';
import { api, errorMessage } from '../../services/api.js';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { Alert, Badge, Button, Card, Spinner } from '../../components/ui/index.jsx';
import { ExportButton } from '../masterdata/shared.jsx';

const thisMonth = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Tunis' }).format(new Date()).slice(0, 7);
const dinars = (millimes) => (Number(millimes) / 1000).toLocaleString('fr-TN', { minimumFractionDigits: 3, maximumFractionDigits: 3 });

// Préparation de la déclaration TEJ : contrôle des données, choix du code d'opération, CSV et XML.
// Le XML n'est proposé que s'il passe la validation contre le schéma officiel de la DGI (côté serveur).
export default function TejPrepCard() {
  const { can } = useAuth();
  const [month, setMonth] = useState(thisMonth());
  const [codes, setCodes] = useState([]);
  const [state, setState] = useState({ loading: true });
  const [msg, setMsg] = useState(null);
  const [deposit, setDeposit] = useState(null);
  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true }));
    try { const r = await api.get('/withholdings/purchases/tej-prep', { params: { month } }); setState({ rows: r.data.data, meta: r.data.meta }); } catch (e) { setState({ error: errorMessage(e) }); }
  }, [month]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { api.get('/withholdings/tej/codes').then((r) => setCodes(r.data.data)).catch(() => {}); }, []);

  const save = async (row, patch) => {
    const next = { operationCode: row.operationCode ?? '', cnpc: row.cnpc, pCharge: row.pCharge, ...patch };
    if (!next.operationCode) return;
    try { await api.put(`/withholdings/purchases/${row.invoiceId}/tej-operation`, next); await load(); } catch (e) { setMsg({ tone: 'error', text: errorMessage(e) }); }
  };
  const downloadXml = async () => {
    setMsg(null); setDeposit(null);
    try {
      const r = await api.get('/withholdings/purchases/tej-prep/xml', { params: { month }, responseType: 'blob' });
      const url = URL.createObjectURL(r.data); const a = document.createElement('a');
      const cd = r.headers['content-disposition'] ?? ''; a.href = url; const fileName = /filename="([^"]+)"/.exec(cd)?.[1] ?? `tej-${month}.xml`; a.download = fileName; a.click(); URL.revokeObjectURL(url);
      setDeposit({ fileName });
    } catch (e) {
      let text = errorMessage(e);
      try { const j = JSON.parse(await e.response.data.text()); text = j.error?.message ?? text; if (j.error?.details?.errors) text += ` — ${j.error.details.errors.slice(0, 3).join(' | ')}`; } catch { /* message déjà extrait */ }
      setMsg({ tone: 'error', text });
    }
  };
  const m = state.meta;
  return (
    <Card className="mb-4">
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-slate-200 p-4">
        <div><h2 className="text-base font-semibold">Préparation de la déclaration TEJ</h2>
          <p className="text-xs text-slate-500">Retenues opérées sur les achats payés dans le mois. Aide à la préparation : MHFac ne dépose rien et ne garantit pas l'acceptation du fichier par TEJ. Échéance : fin du mois suivant le paiement.</p></div>
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-xs text-slate-600">Mois de paiement<input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} className="mt-1 block rounded-md border border-slate-300 px-3 py-2 text-sm" /></label>
          <ExportButton path="/withholdings/purchases/tej-prep/export" params={{ month }} filename={`preparation-tej-${month}.csv`} onError={(text) => setMsg({ tone: 'error', text })} />
          <Button variant="secondary" onClick={downloadXml}>Générer le XML TEJ</Button>
        </div>
      </div>
      <div className="px-4 pt-3"><Alert tone={msg?.tone ?? 'info'} onClose={() => setMsg(null)}>{msg?.text}</Alert></div>
      {deposit && (
        <div className="mx-4 mt-3 rounded-md border border-green-200 bg-green-50 p-3 text-sm text-slate-800" role="status">
          <p className="font-medium">Fichier généré et conforme au schéma XSD de la DGI : <span className="font-mono text-xs">{deposit.fileName}</span></p>
          <p className="mt-1 text-xs text-slate-600">MHFac ne dépose rien à votre place. Pour le déposer vous-même :</p>
          <ol className="mt-1 list-decimal space-y-0.5 pl-5 text-xs text-slate-700">
            <li>Connectez-vous à <a href="https://tej.finances.gov.tn" target="_blank" rel="noopener noreferrer" className="text-brand-700 underline">tej.finances.gov.tn</a> avec votre compte adhérent.</li>
            <li>Choisissez le dépôt de fichier des certificats de retenue à la source.</li>
            <li>Sélectionnez le fichier téléchargé <strong>sans changer son nom</strong> (matricule-année-mois-acte.xml).</li>
            <li>La plateforme fait deux contrôles : la structure du fichier, puis la cohérence des données. Corrigez ici puis régénérez si elle refuse le fichier.</li>
          </ol>
          <p className="mt-1 text-xs text-slate-600">La conformité au schéma ne garantit pas l'acceptation par TEJ. Faites relire par votre comptable avant le dépôt. Échéance : fin du mois suivant le paiement.</p>
        </div>)}
      {state.loading ? <Spinner /> : state.error ? <div className="p-4"><Alert tone="error">{state.error}</Alert></div> : state.rows.length === 0 ? <p className="p-4 text-sm text-slate-500">Aucune retenue payée sur ce mois.</p> : (
        <div className="p-4">
          <p className="mb-3 text-sm"><Badge tone="green">{m.ready} prête{m.ready > 1 ? 's' : ''}</Badge>{' '}{m.withErrors > 0 && <Badge tone="red">{m.withErrors} à corriger</Badge>}</p>
          <div className="overflow-x-auto"><table className="w-full min-w-[760px] text-left text-sm">
            <thead className="border-b border-slate-200 text-xs uppercase text-slate-500"><tr><th className="py-2 pr-3">Facture</th><th className="pr-3">Fournisseur</th><th className="pr-3 text-right">Retenue (DT)</th><th className="pr-3">Code d'opération TEJ</th><th className="pr-3">CNPC</th><th>Prise en charge</th></tr></thead>
            <tbody className="divide-y divide-slate-100">{state.rows.map((r) => (
              <tr key={r.invoiceId} className="align-top">
                <td className="py-2 pr-3 font-mono text-xs">{r.invoice}
                  {r.issues.length > 0 && <ul className="mt-1 list-disc pl-4 font-sans text-xs">{r.issues.map((i) => <li key={i.code} className={i.level === 'error' ? 'text-red-700' : 'text-orange-600'}>{i.message}</li>)}</ul>}</td>
                <td className="pr-3">{r.supplier}</td><td className="pr-3 text-right tabular-nums">{dinars(r.retenue)}</td>
                <td className="pr-3"><select aria-label={`Code d'opération ${r.invoice}`} disabled={!can('withholding.write')} value={r.operationCode ?? ''} onChange={(e) => save(r, { operationCode: e.target.value })} className="max-w-[260px] rounded-md border border-slate-300 bg-white px-2 py-1 text-xs">
                  <option value="">— choisir —</option>{codes.map((c) => <option key={c.code} value={c.code}>{c.code} · {Number(c.rate)} % · {c.label}</option>)}</select></td>
                <td className="pr-3"><input type="checkbox" aria-label={`CNPC ${r.invoice}`} disabled={!can('withholding.write') || !r.operationCode} checked={r.cnpc} onChange={(e) => save(r, { cnpc: e.target.checked })} /></td>
                <td><input type="checkbox" aria-label={`Prise en charge ${r.invoice}`} disabled={!can('withholding.write') || !r.operationCode} checked={r.pCharge} onChange={(e) => save(r, { pCharge: e.target.checked })} /></td>
              </tr>))}</tbody></table></div>
        </div>)}
    </Card>
  );
}
