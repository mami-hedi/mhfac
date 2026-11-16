// Génération du fichier XML TEJ (certificats de retenue à la source) — structure d'après l'exemple complet du
// cahier des charges TEJ de septembre 2026 (§7.6) et les XSD officiels TEJDeclarationRS_v1.0 / TEJRSCodesOperations_v1.0 / TEJISOPaysDevises. Le fichier n'est proposé à l'export QUE s'il passe la validation
// contre le XSD officiel de la DGI (voir validateAgainstXsd) ; ceci n'est pas une garantie d'acceptation par TEJ.
import fs from 'node:fs';
import path from 'node:path';
import { validateXML } from 'xmllint-wasm';

// Noms d'éléments tels qu'ils figurent dans l'exemple officiel (le texte du PDF en contient des variantes :
// seule la validation XSD tranche).
export const SCHEMA = { root: 'DeclarationsRS', version: '1.0', xsdName: 'TEJDeclarationRS_v1.0.xsd', name: 'NometprenonOuRaisonsociale', contact: 'InfosContact', paymentDate: 'DatePayement', total: 'TotalPayement' };

// Règle du cahier des charges (« Remarques importantes ») : pas de caractères spéciaux, de séquences interdites ni de commentaires.
export function cleanText(v, max = 150) {
  let s = String(v ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[œŒ]/g, 'oe').replace(/[æÆ]/g, 'ae');
  s = s.replace(/--|\/\*|\*\/|&#/g, ' ').replace(/'\s*(?=(or|and)\b)/gi, ' ').replace(/[^A-Za-z0-9 .,'()@_\-/]/g, ' ');
  return s.replace(/\s+/g, ' ').trim().slice(0, max);
}
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const tag = (n, v, attrs = '') => `<${n}${attrs}>${esc(v)}</${n}>`;
export const ddmmyyyy = (iso) => iso.split('-').reverse().join('/');

const MF_RE = /^\d{7}[A-Z]$/;
export const normalizeMf = (v) => String(v ?? '').replace(/[\s/.-]/g, '').toUpperCase();
export const isMf = (v) => MF_RE.test(normalizeMf(v));
export const fileName = (declarantTaxId, year, month, acte) => `${normalizeMf(declarantTaxId)}-${year}-${month}-${acte}.xml`;

/** certs : [{ ref, paymentDate:'YYYY-MM-DD', beneficiary:{taxId, category:'PM'|'PP', resident:0|1, name, address, activity?, email, phone},
 *            operation:{ code, year, cnpc, pCharge, ht, tva, ttc, taux, tauxTva, rs, net } }]  — montants en millimes (entiers, string/BigInt) */
export function buildTejXml({ declarant, year, month, acte = 0, certs }) {
  const L = [];
  L.push('<?xml version="1.0" encoding="UTF-8"?>');
  L.push(`<${SCHEMA.root} xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" VersionSchema="${SCHEMA.version}" xsi:noNamespaceSchemaLocation="${SCHEMA.xsdName}">`);
  L.push('<Declarant>', tag('TypeIdentifiant', '1'), tag('Identifiant', normalizeMf(declarant.taxId)), tag('CategorieContribuable', declarant.category), '</Declarant>');
  L.push('<ReferenceDeclaration>', tag('ActeDepot', acte), tag('AnneeDepot', year), tag('MoisDepot', month), '</ReferenceDeclaration>');
  L.push('<AjouterCertificats>');
  for (const c of certs) {
    const b = c.beneficiary; const o = c.operation;
    L.push('<Certificat>', '<Beneficiaire>', '<IdTaxpayer>', '<MatriculeFiscal>', tag('TypeIdentifiant', '1'), tag('Identifiant', normalizeMf(b.taxId)), tag('CategorieContribuable', b.category), '</MatriculeFiscal>', '</IdTaxpayer>',
      tag('Resident', b.resident), tag(SCHEMA.name, cleanText(b.name)), tag('Adresse', cleanText(b.address)));
    if (b.activity) L.push(tag('Activite', cleanText(b.activity)));
    L.push(`<${SCHEMA.contact}>`, tag('AdresseMail', b.email), tag('NumTel', cleanText(b.phone, 30)), `</${SCHEMA.contact}>`, '</Beneficiaire>');
    L.push(tag(SCHEMA.paymentDate, ddmmyyyy(c.paymentDate)), tag('Ref_certif_chez_declarant', cleanText(c.ref, 60)));
    L.push('<ListeOperations>', `<Operation IdTypeOperation="${o.code}">`, tag('AnneeFacturation', o.year), tag('CNPC', o.cnpc), tag('P_Charge', o.pCharge), tag('MontantHT', o.ht), tag('TauxRS', o.taux), tag('TauxTVA', o.tauxTva), tag('MontantTVA', o.tva), tag('MontantTTC', o.ttc), tag('MontantRS', o.rs), tag('MontantNetServi', o.net), '</Operation>', '</ListeOperations>');
    L.push(`<${SCHEMA.total}>`, tag('TotalMontantHT', o.ht), tag('TotalMontantTVA', o.tva), tag('TotalMontantTTC', o.ttc), tag('TotalMontantRS', o.rs), tag('TotalMontantNetServi', o.net), `</${SCHEMA.total}>`, '</Certificat>');
  }
  L.push('</AjouterCertificats>', `</${SCHEMA.root}>`);
  return `${L.join('\n')}\n`;
}

/** Charge les XSD officiels (dossier TEJ_XSD_DIR, défaut server/schemas/tej). Retourne null s'ils sont absents. */
export function loadXsd(dir = process.env.TEJ_XSD_DIR || path.resolve('schemas/tej')) {
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.xsd'));
  const main = files.find((f) => /^(TEJ)?DeclarationRS/i.test(f));
  if (!main) return null;
  const read = (f) => ({ fileName: f, contents: fs.readFileSync(path.join(dir, f), 'utf8') });
  return { main: read(main), others: files.filter((f) => f !== main).map(read), version: main };
}

export async function validateAgainstXsd(xml, xsd, name = 'declaration.xml') {
  const r = await validateXML({ xml: [{ fileName: name, contents: xml }], schema: [xsd.main], preload: xsd.others });
  return { valid: r.valid, errors: (r.errors ?? []).map((e) => e.message ?? String(e)).slice(0, 20) };
}
