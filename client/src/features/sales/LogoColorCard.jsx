// « Logo et couleur » : carte AUTONOME. Le logo est enregistré dès qu'il est choisi (ou retiré) et le résultat s'affiche dans la carte,
// à côté du bouton ; la couleur a son propre bouton. Cette carte n'est jamais écrasée par le formulaire fiscal.
import { useEffect, useRef, useState } from 'react';
import { Upload } from 'lucide-react';
import { api, errorMessage } from '../../services/api.js';
import { Alert, Button, Card } from '../../components/ui/index.jsx';
import { prepareLogo } from '../../utils/logoImage.js';

const HEADERS = [
  ['classic', 'Classique', 'Logo et identité à gauche, titre à droite'], ['centered', 'Centré', 'Logo et identité au centre, titre dessous'],
  ['band', 'Bandeau couleur', 'Bandeau plein à la couleur de l\'entreprise'], ['minimal', 'Sobre', 'Titre à gauche, identité à droite'], ['custom', 'Personnalisé', 'Votre propre texte'],
];
const FOOTERS = [
  ['classic', 'Classique', 'Identité et mentions fiscales sur une ligne'], ['columns', '3 colonnes', 'Adresse, contacts et matricule fiscal'],
  ['minimal', 'Sobre', 'Numéro de page uniquement'], ['custom', 'Personnalisé', 'Votre propre texte (IBAN, capital, slogan…)'],
];
const FRAME_KEYS = ['headerStyle', 'headerText', 'headerAlign', 'showLogo', 'footerStyle', 'footerText', 'footerAlign', 'showPageNumber'];
const frameOf = (b) => ({ headerStyle: b.headerStyle ?? 'classic', headerText: b.headerText ?? '', headerAlign: b.headerAlign ?? 'left', showLogo: b.showLogo !== false, footerStyle: b.footerStyle ?? 'classic', footerText: b.footerText ?? '', footerAlign: b.footerAlign ?? 'center', showPageNumber: b.showPageNumber !== false });
// Petites vignettes schématiques (haut de page pour l'en-tête, bas de page pour le pied).
function Thumb({ part, id }) {
  const g = '#cbd5e1'; const a = 'currentColor';
  const head = {
    classic: <><rect x="4" y="4" width="8" height="8" rx="2" fill={a} /><rect x="15" y="5" width="16" height="2" fill={g} /><rect x="15" y="9" width="12" height="1.5" fill={g} /><rect x="40" y="5" width="16" height="4" fill={a} /><rect x="4" y="15" width="52" height="1.5" fill={a} /></>,
    centered: <><rect x="26" y="3" width="8" height="8" rx="2" fill={a} /><rect x="18" y="13" width="24" height="2" fill={g} /><rect x="4" y="18" width="52" height="1.5" fill={a} /><rect x="22" y="22" width="16" height="3" fill={a} /></>,
    band: <><rect x="0" y="0" width="60" height="17" fill={a} /><rect x="4" y="4" width="8" height="8" rx="2" fill="#fff" /><rect x="15" y="5" width="16" height="2" fill="#fff" opacity=".8" /><rect x="40" y="5" width="16" height="4" fill="#fff" /></>,
    minimal: <><rect x="4" y="4" width="18" height="4" fill={a} /><rect x="4" y="10" width="10" height="2" fill={g} /><rect x="38" y="4" width="18" height="2" fill={g} /><rect x="42" y="8" width="14" height="1.5" fill={g} /><rect x="4" y="15" width="52" height="1" fill="#94a3b8" /></>,
    custom: <><rect x="4" y="4" width="30" height="2.5" fill={a} /><rect x="4" y="9" width="40" height="1.5" fill={g} strokeDasharray="2 1" /><rect x="4" y="12" width="34" height="1.5" fill={g} /><rect x="4" y="16" width="52" height="1.5" fill={a} /></>,
  };
  const foot = {
    classic: <><rect x="4" y="22" width="52" height="0.8" fill={g} /><rect x="12" y="27" width="36" height="1.8" fill={g} /><rect x="26" y="31" width="8" height="1.5" fill={g} /></>,
    columns: <><rect x="4" y="22" width="52" height="0.8" fill={g} /><rect x="4" y="26" width="14" height="1.6" fill={g} /><rect x="23" y="26" width="14" height="1.6" fill={g} /><rect x="42" y="26" width="14" height="1.6" fill={g} /><rect x="26" y="32" width="8" height="1.5" fill={g} /></>,
    minimal: <><rect x="4" y="22" width="52" height="0.8" fill={g} /><rect x="46" y="27" width="10" height="1.8" fill={g} /></>,
    custom: <><rect x="4" y="22" width="52" height="0.8" fill={g} /><rect x="10" y="26" width="40" height="1.8" fill={a} /><rect x="16" y="30" width="28" height="1.5" fill={g} /><rect x="26" y="34" width="8" height="1.5" fill={g} /></>,
  };
  return <svg viewBox="0 0 60 38" className="h-10 w-16 rounded border border-slate-200 bg-white" aria-hidden="true" style={{ color: 'var(--thumb-accent, #1d4ed8)' }}>{(part === 'head' ? head : foot)[id]}</svg>;
}
function Choices({ name, items, value, onChange, disabled, part, accent }) {
  return (
    <div role="radiogroup" aria-label={name} className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
      {items.map(([id, label, desc]) => {
        const on = value === id;
        return (
          <button key={id} type="button" role="radio" aria-checked={on} disabled={disabled} onClick={() => onChange(id)} style={{ '--thumb-accent': accent }}
            className={`flex items-center gap-3 rounded-lg border p-2 text-left text-sm transition ${on ? 'border-brand-600 bg-brand-50 ring-1 ring-brand-600' : 'border-slate-200 bg-white hover:border-slate-400'} disabled:cursor-not-allowed disabled:opacity-60`}>
            <Thumb part={part} id={id} />
            <span><span className="block font-medium text-slate-900">{label}</span><span className="block text-xs text-slate-500">{desc}</span></span>
          </button>
        );
      })}
    </div>
  );
}
const ALIGNS = [['left', 'À gauche'], ['center', 'Centré'], ['right', 'À droite']];
const selectCls = 'mt-1 block rounded-md border border-slate-300 bg-white px-3 py-2 text-sm disabled:opacity-60';

export default function LogoColorCard({ editable, initial }) {
  const [saved, setSaved] = useState(initial); // dernier état connu du serveur
  const [form, setForm] = useState({ accentColor: initial.accentColor, template: initial.template, ...frameOf(initial) });
  const [busy, setBusy] = useState(''); const [msg, setMsg] = useState({ tone: 'success', text: '' }); const file = useRef();

  const save = async (patch, okText) => {
    setMsg({ tone: 'success', text: '' });
    try {
      const r = await api.patch('/companies/current/settings', { branding: patch });
      const b = r.data.data.branding; setSaved(b); setForm({ accentColor: b.accentColor, template: b.template, ...frameOf(b) });
      setMsg({ tone: 'success', text: okText }); return true;
    } catch (e) { setMsg({ tone: 'error', text: errorMessage(e) }); return false; }
  };
  const pick = async (e) => {
    const f = e.target.files?.[0]; e.target.value = ''; if (!f) return;
    setBusy('logo');
    try { const dataUrl = await prepareLogo(f); await save({ logo: dataUrl }, 'Logo enregistré.'); }
    catch (err) { setMsg({ tone: 'error', text: err.message }); }
    setBusy('');
  };
  const remove = async () => { setBusy('logo'); await save({ logo: null }, 'Logo retiré.'); setBusy(''); };
  // Aperçu en direct : le serveur génère le PDF d'un document fictif avec la couleur en cours d'édition (rien n'est enregistré).
  const frame = frameOf(form); const frameKey = JSON.stringify(frame);
  const [kind, setKind] = useState('invoice'); const [pv, setPv] = useState({ url: '', loading: false, error: '' });
  useEffect(() => {
    let alive = true; let url = '';
    const t = setTimeout(async () => {
      setPv((p) => ({ ...p, loading: true, error: '' }));
      try {
        const r = await api.post('/sales/sample-pdf', { kind, accentColor: form.accentColor, branding: frame }, { responseType: 'blob' });
        url = URL.createObjectURL(r.data); if (alive) setPv((p) => { if (p.url) URL.revokeObjectURL(p.url); return { url, loading: false, error: '' }; }); else URL.revokeObjectURL(url);
      } catch (e) { if (alive) setPv((p) => ({ ...p, loading: false, error: 'Aperçu indisponible' })); }
    }, 500);
    return () => { alive = false; clearTimeout(t); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, form.accentColor, frameKey, saved.logo]);
  useEffect(() => () => { setPv((p) => { if (p.url) URL.revokeObjectURL(p.url); return p; }); }, []);
  const savedFrame = frameOf(saved);
  const dirty = form.accentColor !== saved.accentColor || form.template !== saved.template || FRAME_KEYS.some((k) => form[k] !== savedFrame[k]);
  const saveStyle = async () => { setBusy('style'); await save(form, 'Modèle des documents enregistré.'); setBusy(''); };

  return (
    <Card className="p-5">
      <h2 className="mb-4 font-semibold text-slate-900">Logo, couleur et modèle des documents</h2>
      <div className="mb-3"><Alert tone={msg.tone}>{msg.text}</Alert></div>
      <div className="flex flex-wrap items-center gap-4">
        {saved.logo ? <img src={saved.logo} alt="Logo" className="h-14 max-w-[160px] rounded border border-slate-200 object-contain p-1" /> : <div className="flex h-14 w-32 items-center justify-center rounded border border-dashed border-slate-300 text-xs text-slate-400">Aucun logo</div>}
        {editable && <>
          <input ref={file} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" aria-label="Fichier logo" onChange={pick} />
          <Button type="button" variant="secondary" loading={busy === 'logo'} onClick={() => file.current.click()}><Upload size={16} aria-hidden /> {saved.logo ? 'Changer le logo' : 'Choisir un logo'}</Button>
          {saved.logo && <Button type="button" variant="ghost" disabled={busy === 'logo'} onClick={remove}>Retirer</Button>}
        </>}
      </div>
      <p className="mt-2 text-xs text-slate-500">PNG, JPEG ou WebP. Le logo est automatiquement réduit et enregistré dès que vous le choisissez.</p>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <label className="flex items-center gap-2 text-sm">Couleur des documents <input type="color" aria-label="Couleur des documents" disabled={!editable} className="h-9 w-12 rounded border border-slate-300" value={form.accentColor} onChange={(e) => setForm({ ...form, accentColor: e.target.value })} /></label>
      </div>
      <div className="mt-6">
        <h3 className="mb-1 text-sm font-semibold text-slate-900">Modèle d'en-tête</h3>
        <p className="mb-2 text-xs text-slate-500">Partie haute des devis, commandes, factures, avoirs et bons de livraison.</p>
        <Choices name="Modèle d'en-tête" items={HEADERS} value={form.headerStyle} onChange={(v) => setForm({ ...form, headerStyle: v })} disabled={!editable} part="head" accent={form.accentColor} />
        {form.headerStyle === 'custom' && (
          <div className="mt-3 grid gap-3 rounded-lg border border-slate-200 bg-slate-50 p-3 sm:grid-cols-2">
            <label className="text-sm sm:col-span-2">Texte de l'en-tête (une ligne par retour à la ligne, 5 lignes affichées au plus)
              <textarea rows={4} maxLength={600} disabled={!editable} value={form.headerText} onChange={(e) => setForm({ ...form, headerText: e.target.value })}
                placeholder={'Nom ou slogan de l\'entreprise\nActivité, capital, adresse…\nMF, RC, téléphone…'} className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
              <span className="text-xs text-slate-500">{form.headerText.length}/600 — vide : l'identité de l'entreprise est utilisée. Le titre et le numéro du document restent toujours affichés.</span></label>
            <label className="text-sm">Alignement<select aria-label="Alignement de l'en-tête" disabled={!editable} value={form.headerAlign} onChange={(e) => setForm({ ...form, headerAlign: e.target.value })} className={selectCls}>{ALIGNS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
            <label className="flex items-center gap-2 self-end pb-2 text-sm"><input type="checkbox" disabled={!editable} checked={form.showLogo} onChange={(e) => setForm({ ...form, showLogo: e.target.checked })} /> Afficher le logo</label>
          </div>)}
      </div>
      <div className="mt-6">
        <h3 className="mb-1 text-sm font-semibold text-slate-900">Modèle de pied de page</h3>
        <p className="mb-2 text-xs text-slate-500">Bas de chaque page. Le statut (brouillon, annulé) et la pagination restent gérés par MHFac.</p>
        <Choices name="Modèle de pied de page" items={FOOTERS} value={form.footerStyle} onChange={(v) => setForm({ ...form, footerStyle: v })} disabled={!editable} part="foot" accent={form.accentColor} />
        {form.footerStyle === 'custom' && (
          <div className="mt-3 grid gap-3 rounded-lg border border-slate-200 bg-slate-50 p-3 sm:grid-cols-2">
            <label className="text-sm sm:col-span-2">Texte du pied de page (3 lignes affichées au plus)
              <textarea rows={3} maxLength={400} disabled={!editable} value={form.footerText} onChange={(e) => setForm({ ...form, footerText: e.target.value })}
                placeholder={'SARL au capital de 10 000 DT · MF 1234567/A/M/000\nIBAN TN59 … · Banque …'} className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
              <span className="text-xs text-slate-500">{form.footerText.length}/400 — vide : identité et mentions fiscales de l'entreprise.</span></label>
            <label className="text-sm">Alignement<select aria-label="Alignement du pied de page" disabled={!editable} value={form.footerAlign} onChange={(e) => setForm({ ...form, footerAlign: e.target.value })} className={selectCls}>{ALIGNS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
            <label className="flex items-center gap-2 self-end pb-2 text-sm"><input type="checkbox" disabled={!editable} checked={form.showPageNumber} onChange={(e) => setForm({ ...form, showPageNumber: e.target.checked })} /> Afficher « Page 1/2 »</label>
          </div>)}
      </div>
      {editable && <div className="mt-4"><Button type="button" loading={busy === 'style'} disabled={!dirty} onClick={saveStyle}>Enregistrer le modèle</Button></div>}
      <div className="mt-6">
        <div className="mb-2 flex flex-wrap items-center gap-2"><h3 className="text-sm font-semibold text-slate-900">Aperçu du modèle</h3>
          {[['invoice', 'Facture'], ['quote', 'Devis'], ['delivery_note', 'Bon de livraison']].map(([k, l]) => <Button key={k} type="button" variant={kind === k ? 'primary' : 'secondary'} onClick={() => setKind(k)}>{l}</Button>)}</div>
        <p className="mb-2 text-xs text-slate-500">Document fictif (filigrane « EXEMPLE ») : il suit la couleur, le logo, l'en-tête et le pied de page choisis ci-dessus, sans rien enregistrer. Les documents déjà émis utilisent le modèle en vigueur au moment de leur impression.</p>
        {pv.error ? <Alert tone="error">{pv.error}</Alert> : pv.url ? <iframe title="Aperçu du PDF" src={pv.url} className={`h-[560px] w-full rounded border border-slate-200 ${pv.loading ? 'opacity-60' : ''}`} /> : <p className="text-sm text-slate-500">Génération de l'aperçu…</p>}
      </div>
    </Card>
  );
}
