import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Download, Upload } from 'lucide-react';
import { api, errorMessage } from '../../services/api.js';
import { Alert, Button, Modal } from '../../components/ui/index.jsx';

export function Pagination({ meta, onPage }) {
  if (!meta || meta.total === 0) return null;
  return (
    <div className="flex items-center justify-between border-t border-slate-200 px-4 py-3 text-sm text-slate-600">
      <span>{meta.total} résultat{meta.total > 1 ? 's' : ''} · page {meta.page}/{meta.pages}</span>
      <div className="flex gap-1">
        <Button variant="secondary" aria-label="Page précédente" disabled={meta.page <= 1} onClick={() => onPage(meta.page - 1)}><ChevronLeft size={16} /></Button>
        <Button variant="secondary" aria-label="Page suivante" disabled={meta.page >= meta.pages} onClick={() => onPage(meta.page + 1)}><ChevronRight size={16} /></Button>
      </div>
    </div>
  );
}

// Export via l'API authentifiee (le jeton est en memoire : un simple lien <a> ne l'enverrait pas).
export async function downloadCsv(path, params, filename) {
  const r = await api.get(path, { params, responseType: 'blob' });
  const url = URL.createObjectURL(r.data);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

export function ExportButton({ path, params, filename, onError }) {
  const [busy, setBusy] = useState(false);
  return (
    <Button variant="secondary" loading={busy} onClick={async () => { setBusy(true); try { await downloadCsv(path, params, filename); } catch (e) { onError?.(errorMessage(e)); } finally { setBusy(false); } }}>
      <Download size={16} aria-hidden /> Exporter
    </Button>
  );
}

// Import en 2 temps : aperçu (dryRun, rien n'est écrit) puis confirmation.
export function ImportModal({ path, title, columnsHint, onClose, onDone }) {
  const [csv, setCsv] = useState('');
  const [fileName, setFileName] = useState('');
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const input = useRef();

  const pick = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setError(''); setPreview(null);
    if (f.size > 800_000) { setError('Fichier trop volumineux (800 Ko maximum, 1000 lignes).'); return; }
    setFileName(f.name); setCsv(await f.text());
  };
  const run = async (dryRun, skipInvalid = false) => {
    setBusy(true); setError('');
    try {
      const r = await api.post(`${path}/import`, { csv, dryRun, skipInvalid });
      if (dryRun) setPreview(r.data.data); else onDone(r.data.data);
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  };
  return (
    <Modal title={title} onClose={onClose} size="lg">
      <div className="space-y-4">
        <Alert tone="error">{error}</Alert>
        <p className="text-sm text-slate-600">Fichier CSV (séparateur « ; » ou « , », encodage UTF-8). {columnsHint}</p>
        <div className="flex items-center gap-3">
          <input ref={input} type="file" accept=".csv,text/csv" onChange={pick} className="hidden" aria-label="Fichier CSV" />
          <Button variant="secondary" onClick={() => input.current.click()}><Upload size={16} aria-hidden /> Choisir un fichier</Button>
          <span className="truncate text-sm text-slate-500">{fileName || 'Aucun fichier'}</span>
        </div>
        {preview && (
          <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-sm" data-testid="import-preview">
            <p><strong>{preview.valid}</strong> ligne(s) valide(s) sur {preview.total}{preview.errors.length > 0 && <>, <strong className="text-red-700">{preview.errors.length}</strong> en erreur</>}.</p>
            {preview.errors.length > 0 && (
              <ul className="mt-2 max-h-40 list-disc space-y-1 overflow-y-auto pl-5 text-red-700">
                {preview.errors.slice(0, 50).map((x, i) => <li key={i}>Ligne {x.line} : {x.message}</li>)}
              </ul>
            )}
          </div>
        )}
        <div className="flex flex-wrap justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={onClose}>Annuler</Button>
          <Button variant="secondary" disabled={!csv} loading={busy} onClick={() => run(true)}>Vérifier</Button>
          {preview && preview.valid > 0 && (
            <Button loading={busy} onClick={() => run(false, preview.errors.length > 0)}>
              {preview.errors.length > 0 ? `Importer les ${preview.valid} lignes valides` : `Importer ${preview.valid} ligne(s)`}
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}

export function useDebounced(value, ms = 300) {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}
