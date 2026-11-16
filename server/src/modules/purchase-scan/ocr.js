// Lecture locale et GRATUITE d'un document : aucun service externe, rien ne quitte le serveur.
//  - PDF avec couche texte (la plupart des factures numériques) : texte extrait directement avec pdf.js (fiable).
//  - PDF scanné ou image : OCR avec Tesseract (tesseract.js, langue française embarquée, fonctionne hors ligne).
import { createRequire } from 'node:module';
import path from 'node:path';
import { createWorker } from 'tesseract.js';
import { HttpError } from '../../utils/httpError.js';

const require = createRequire(import.meta.url);
const LANG_PATH = path.dirname(require.resolve('@tesseract.js-data/fra/package.json')).replace(/fra$/, '');
const MAX_PAGES = 3;
const OCR_TIMEOUT_MS = 120000;

let workerPromise = null; // un seul worker réutilisé (chargement des langues coûteux) ; les OCR sont sérialisés
let queue = Promise.resolve();
async function getWorker() {
  workerPromise ??= createWorker('fra', 1, {
    langPath: path.join(path.dirname(require.resolve('@tesseract.js-data/fra/package.json')), '4.0.0'), gzip: true, cachePath: undefined,
  }).then(async (w) => { await w.setParameters({ tessedit_pageseg_mode: '4', preserve_interword_spaces: '1' }); return w; }) // 4 = colonne unique de tailles variables : garde les colonnes du tableau
    .catch((e) => { workerPromise = null; throw e; });
  return workerPromise;
}
export async function shutdownOcr() { if (workerPromise) { const w = await workerPromise.catch(() => null); workerPromise = null; await w?.terminate(); } }

async function ocrImage(png) {
  const run = async () => {
    const w = await getWorker();
    let timer;
    try { return (await Promise.race([w.recognize(png), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), OCR_TIMEOUT_MS); })])).data.text; }
    finally { clearTimeout(timer); }
  };
  const p = queue.then(run, run); queue = p.catch(() => {});
  try { return await p; } catch (e) { await shutdownOcr(); throw new HttpError(502, 'EXTRACTION_FAILED', e.message === 'timeout' ? 'La lecture du document a pris trop de temps' : 'La lecture du document a échoué'); }
}

// Reconstitue des lignes de texte à partir des fragments pdf.js (regroupés par ordonnée).
function pageToLines(items) {
  const rows = [];
  for (const it of items) {
    if (!it.str?.trim()) continue; const y = Math.round(it.transform[5]); const x = it.transform[4];
    let row = rows.find((r) => Math.abs(r.y - y) <= 3); if (!row) { row = { y, parts: [] }; rows.push(row); }
    row.parts.push({ x, s: it.str, w: it.width });
  }
  return rows.sort((a, b) => b.y - a.y).map((r) => {
    const parts = r.parts.sort((a, b) => a.x - b.x); let line = ''; let end = null;
    for (const p of parts) { line += (end != null && p.x - end > 6 ? '  ' : end != null && p.x - end > 0.5 ? ' ' : '') + p.s; end = p.x + p.w; }
    return line;
  }).join('\n');
}

export async function readDocument({ buffer, mime }) {
  if (mime !== 'application/pdf') return { text: await ocrImage(buffer), method: 'ocr' };
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  let doc; let loadingTask;
  try { loadingTask = pdfjs.getDocument({ data: new Uint8Array(buffer), isEvalSupported: false, useSystemFonts: false, disableFontFace: true, verbosity: 0 }); doc = await loadingTask.promise; }
  catch { throw new HttpError(422, 'UNREADABLE_FILE', 'Ce PDF est illisible ou protégé par mot de passe'); }
  const n = Math.min(doc.numPages, MAX_PAGES); let text = '';
  for (let i = 1; i <= n; i += 1) { const page = await doc.getPage(i); text += `${pageToLines((await page.getTextContent()).items)}\n`; }
  if (text.replace(/\s/g, '').length >= 40) { await loadingTask.destroy(); return { text, method: 'pdf-text' }; }
  // PDF scanné : on rend chaque page en image puis OCR
  const { createCanvas } = await import('@napi-rs/canvas'); let ocr = '';
  for (let i = 1; i <= n; i += 1) {
    const page = await doc.getPage(i); const vp = page.getViewport({ scale: 2.2 }); const canvas = createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp, canvas }).promise; ocr += `${await ocrImage(canvas.toBuffer('image/png'))}\n`;
  }
  await loadingTask.destroy(); return { text: ocr, method: 'pdf-ocr' };
}
