// Extraction automatique d'une facture fournisseur à partir d'un PDF / d'une image — 100 % GRATUITE et LOCALE.
// Aucun service externe, aucune clé API, aucun coût : le document ne quitte jamais le serveur.
// Interface DocumentExtractor : extract({ buffer, mime }) -> objet brut (validé ensuite par normalize()).
// Le résultat n'est JAMAIS enregistré comptablement tel quel : il pré-remplit un brouillon que l'utilisateur relit.
import { readDocument } from './ocr.js';
import { parseInvoiceText } from './parse.js';
import { HttpError } from '../../utils/httpError.js';

export class LocalExtractor {
  get id() { return 'local-ocr'; }
  async extract({ buffer, mime }) {
    const { text, method } = await readDocument({ buffer, mime });
    if (text.replace(/\s/g, '').length < 20) throw new HttpError(422, 'NO_TEXT_FOUND', 'Aucun texte lisible sur ce document : essayez une image plus nette ou saisissez la facture manuellement.');
    const out = parseInvoiceText(text);
    out.warnings = [...(method === 'pdf-text' ? [] : ['Lecture par reconnaissance optique (OCR) : vérifiez particulièrement les chiffres']), ...out.warnings];
    return out;
  }
}
let current = new LocalExtractor();
export const getExtractor = () => current;
export const setExtractor = (x) => { const prev = current; current = x ?? new LocalExtractor(); return prev; }; // utilisé par les tests
