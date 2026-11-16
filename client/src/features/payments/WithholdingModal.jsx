import { useEffect, useState } from 'react';
import { api, errorMessage } from '../../services/api.js';
import { Alert, Button, Input, Modal } from '../../components/ui/index.jsx';
import { fmtMoney, todayIso } from '../sales/shared.jsx';

// Taux fréquents (à confirmer avec votre comptable selon la nature de l'opération) ; la saisie libre reste possible.
const COMMON = ['0.5', '1', '1.5', '3', '5', '10', '15', '20', '25'];

// Retenue à la source oubliée à l'émission : la facture n'est PAS modifiée, la retenue est enregistrée comme un règlement
// spécial. Le montant est calculé par le serveur (taux × TTC hors timbre) ; l'aperçu ci-dessous vient du serveur.
export default function WithholdingModal({ kind = 'sales', invoice, onClose, onDone }) {
  const base = kind === 'sales' ? '/payments' : '/supplier-payments';
  const [rate, setRate] = useState('1.5'); const [date, setDate] = useState(todayIso());
  const [certificate, setCertificate] = useState(''); const [notes, setNotes] = useState('');
  const [preview, setPreview] = useState(null); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const body = (extra = {}) => ({ invoiceId: invoice.id, rate, date, certificateNumber: certificate || null, notes: notes || null, ...extra });

  useEffect(() => {
    setPreview(null); setError('');
    if (!rate || !date) return undefined;
    const t = setTimeout(() => {
      api.post(`${base}/withholding`, body({ dryRun: true })).then((r) => setPreview(r.data.data.preview)).catch((e) => setError(errorMessage(e)));
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rate, date]);

  const submit = async () => {
    setBusy(true); setError('');
    try { onDone((await api.post(`${base}/withholding`, body())).data.data); }
    catch (e) { setError(errorMessage(e)); setBusy(false); }
  };
  const cur = invoice.currency;
  return (
    <Modal title={`Enregistrer une retenue à la source — ${invoice.number}`} onClose={onClose}>
      <div className="space-y-4">
        <Alert tone="info">La facture reste inchangée. La retenue est enregistrée comme un règlement spécial : elle diminue le reste à payer, apparaît dans la page « Retenues à la source » et reste annulable avec un motif.</Alert>
        <Alert tone="error">{error}</Alert>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="wh-rate" className="mb-1 block text-sm font-medium text-slate-700">Taux (%) *</label>
            <input id="wh-rate" list="wh-rates" inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
            <datalist id="wh-rates">{COMMON.map((r) => <option key={r} value={r} />)}</datalist>
          </div>
          <Input id="wh-date" label="Date de la retenue *" type="date" value={date} max={todayIso()} onChange={(e) => setDate(e.target.value)} />
        </div>
        <Input id="wh-cert" label="N° de certificat de retenue (facultatif, à compléter plus tard)" value={certificate} maxLength={60} onChange={(e) => setCertificate(e.target.value)} />
        <Input id="wh-notes" label="Remarque (facultatif)" value={notes} maxLength={500} onChange={(e) => setNotes(e.target.value)} />
        {preview && (
          <dl className="space-y-1 rounded-md bg-slate-50 p-3 text-sm" data-testid="wh-preview">
            <div className="flex justify-between"><dt>Base (TTC hors timbre)</dt><dd className="tabular-nums">{fmtMoney(preview.base, cur)}</dd></div>
            <div className="flex justify-between font-medium"><dt>Retenue ({Number(preview.rate)} %)</dt><dd className="tabular-nums">{fmtMoney(preview.amount, cur)}</dd></div>
            <div className="flex justify-between"><dt>Reste à payer avant</dt><dd className="tabular-nums">{fmtMoney(preview.balanceBefore, cur)}</dd></div>
            <div className="flex justify-between font-semibold text-brand-700"><dt>Reste à payer après</dt><dd className="tabular-nums">{fmtMoney(preview.balanceAfter, cur)}</dd></div>
          </dl>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>Annuler</Button>
          <Button variant="primary" loading={busy} disabled={!preview || busy} onClick={submit}>Enregistrer la retenue</Button>
        </div>
      </div>
    </Modal>
  );
}

// Annulation d'une retenue ajoutée (motif obligatoire) : rétablit le reste à payer.
export function CancelWithholdingModal({ kind = 'sales', added, onClose, onDone }) {
  const [reason, setReason] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true); setError('');
    try { await api.post(`${kind === 'sales' ? '/payments' : '/supplier-payments'}/${added.paymentId}/cancel`, { reason }); onDone(); }
    catch (e) { setError(errorMessage(e)); setBusy(false); }
  };
  return (
    <Modal title="Annuler la retenue à la source" onClose={onClose}>
      <div className="space-y-4">
        <Alert tone="error">{error}</Alert>
        <p className="text-sm text-slate-600">La retenue {added.paymentNumber} sera conservée en historique (annulée) et le reste à payer de la facture sera rétabli.</p>
        <Input id="wh-cancel-reason" label="Motif (5 caractères minimum) *" value={reason} maxLength={255} onChange={(e) => setReason(e.target.value)} />
        <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Retour</Button><Button variant="danger" loading={busy} disabled={reason.trim().length < 5 || busy} onClick={go}>Annuler la retenue</Button></div>
      </div>
    </Modal>
  );
}
