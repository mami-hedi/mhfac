import { useState } from 'react';
import { api, errorMessage } from '../../services/api.js';
import { Alert, Button, Input, Modal, Select } from '../../components/ui/index.jsx';

export function QuickPartyModal({ kind = 'client', onClose, onDone }) {
  const [v, setV] = useState({ name: '', taxId: '', phone: '', email: '', paymentTermsDays: '0' }); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setV({ ...v, [k]: e.target.value });
  const submit = async () => {
    setBusy(true); setError('');
    try { onDone((await api.post(kind === 'supplier' ? '/suppliers' : '/clients', { name: v.name, taxId: v.taxId || null, phone: v.phone || null, email: v.email || null, paymentTermsDays: Number(v.paymentTermsDays || 0) })).data.data); } catch (e) { setError(errorMessage(e)); setBusy(false); }
  };
  return (
    <Modal title={kind === 'supplier' ? 'Nouveau fournisseur' : 'Nouveau client'} onClose={onClose}><div className="space-y-4">
      <Alert tone="error">{error}</Alert>
      <Input label="Nom / raison sociale *" value={v.name} onChange={set('name')} maxLength={190} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Input label="Matricule fiscal" value={v.taxId} onChange={set('taxId')} maxLength={50} />
        <Input label="Délai de paiement (jours)" type="number" min="0" value={v.paymentTermsDays} onChange={set('paymentTermsDays')} />
        <Input label="Téléphone" value={v.phone} onChange={set('phone')} />
        <Input label="E-mail" type="email" value={v.email} onChange={set('email')} />
      </div>
      <p className="text-xs text-slate-500">Les autres informations (adresse, devise…) se complètent plus tard dans {kind === 'supplier' ? 'Fournisseurs' : 'Clients'}.</p>
      <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Annuler</Button><Button loading={busy} disabled={v.name.trim().length < 2} onClick={submit}>{kind === 'supplier' ? 'Créer le fournisseur' : 'Créer le client'}</Button></div>
    </div></Modal>
  );
}
export function QuickProductModal({ taxRates, initialName, onClose, onDone }) {
  const [v, setV] = useState({ name: initialName ?? '', type: 'product', purchasePrice: '', salePrice: '0', unit: 'unité', taxRateId: taxRates.find((t) => t.isDefault)?.id ?? '', trackStock: true }); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setV({ ...v, [k]: e.target.value });
  const submit = async () => {
    setBusy(true); setError('');
    try { onDone((await api.post('/products', { name: v.name, type: v.type, purchasePrice: v.purchasePrice || null, salePrice: v.salePrice || '0', unit: v.unit || 'unité', taxRateId: v.taxRateId || null, trackStock: v.type === 'product' && v.trackStock })).data.data); } catch (e) { setError(errorMessage(e)); setBusy(false); }
  };
  return (
    <Modal title="Nouvel article" onClose={onClose} size="lg"><div className="space-y-4">
      <Alert tone="error">{error}</Alert>
      <Input label="Désignation *" value={v.name} onChange={set('name')} maxLength={190} />
      <div className="grid gap-4 sm:grid-cols-3">
        <Select label="Type" value={v.type} onChange={set('type')}><option value="product">Produit</option><option value="service">Service</option></Select>
        <Input label="Prix d'achat HT" inputMode="decimal" value={v.purchasePrice} onChange={set('purchasePrice')} />
        <Input label="Prix de vente HT" inputMode="decimal" value={v.salePrice} onChange={set('salePrice')} />
        <Input label="Unité" value={v.unit} onChange={set('unit')} maxLength={20} />
        <Select label="TVA" value={v.taxRateId} onChange={set('taxRateId')}>{taxRates.filter((t) => t.isActive).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select>
        {v.type === 'product' && <div className="flex items-end gap-2 pb-2"><input id="qp-track" type="checkbox" className="h-4 w-4" checked={v.trackStock} onChange={(e) => setV({ ...v, trackStock: e.target.checked })} /><label htmlFor="qp-track" className="text-sm text-slate-700">Suivre le stock</label></div>}
      </div>
      <p className="text-xs text-slate-500">Le code article est généré automatiquement ; la fiche se complète plus tard dans Articles.</p>
      <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Annuler</Button><Button loading={busy} disabled={v.name.trim().length < 2} onClick={submit}>Créer l'article</Button></div>
    </div></Modal>
  );
}

