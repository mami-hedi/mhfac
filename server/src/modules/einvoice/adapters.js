// Couche d'intégration facturation électronique : INTERFACES + adaptateurs de SIMULATION.
//
// ⚠ MHFac n'est PAS homologué, conforme ni connecté à TTN (Tunisie TradeNet) ni à aucune plateforme officielle.
// Le format ci-dessous est un format INTERNE de simulation, inventé pour tester le cycle de vie (préparation, signature, transmission,
// accusé, rejet, erreur, nouvelle tentative). Il ne reproduit AUCUNE spécification fiscale. Brancher un fournisseur réel exige les
// spécifications officielles, un certificat de signature, des accès/identifiants, une phase de tests et une validation par un professionnel.
import { createHash } from 'node:crypto';

export const SIMULATION_FORMAT = 'MHFAC-SIMULATION-JSON/1';
export const NOTICE = 'SIMULATION — format interne MHFac, non conforme TTN, sans valeur fiscale.';

export class TransientProviderError extends Error { constructor(m) { super(m); this.name = 'TransientProviderError'; } }
export class ProviderNotConfiguredError extends Error { constructor(m) { super(m); this.name = 'ProviderNotConfiguredError'; } }

/** @interface InvoiceFormatAdapter : construit le document à transmettre à partir de la facture en base. */
export class InvoiceFormatAdapter { get format() { throw new Error('not implemented'); } async build() { throw new Error('not implemented'); } }
/** @interface ElectronicSignatureAdapter : signe le document ; renvoie { status, signature }. */
export class ElectronicSignatureAdapter { async sign() { throw new Error('not implemented'); } }
/** @interface TransmissionProvider : envoie le document ; submit() -> { outcome: 'accepted'|'rejected'|'transmitted', reference, response } ; peut lever TransientProviderError. */
export class TransmissionProvider { get id() { throw new Error('not implemented'); } get mode() { throw new Error('not implemented'); } async submit() { throw new Error('not implemented'); } async getStatus() { throw new Error('not implemented'); } }

// Sérialisation canonique (clés triées) : le même contenu donne toujours le même hash / la même clé d'idempotence.
export const canonical = (v) => (Array.isArray(v) ? `[${v.map(canonical).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}` : JSON.stringify(v));
export const sha256 = (s) => createHash('sha256').update(s).digest('hex');

export class SimulationFormatAdapter extends InvoiceFormatAdapter {
  get format() { return SIMULATION_FORMAT; }
  async build({ invoice, lines, taxes }) {
    const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
    return {
      _notice: NOTICE, format: SIMULATION_FORMAT,
      document: { type: invoice.kind === 'credit_note' ? 'credit_note' : 'invoice', number: invoice.number, issueDate: invoice.issue_date_s, dueDate: invoice.due_date_s, currency: invoice.currency, exchangeRate: String(invoice.exchange_rate) },
      seller: parse(invoice.company_snapshot), buyer: parse(invoice.client_snapshot),
      lines: lines.map((l) => ({ position: l.position, description: l.description, quantity: String(l.quantity), unitPrice: String(l.unit_price), discountPct: String(l.discount_pct), taxRate: String(l.tax_rate), netAmount: String(l.net_amount) })),
      taxes: taxes.map((t) => ({ rate: String(t.tax_rate), base: String(t.base), amount: String(t.amount) })),
      totals: { totalHt: String(invoice.total_ht), fodecAmount: String(invoice.fodec_amount ?? '0.000'), totalTax: String(invoice.total_tax), totalTtc: String(invoice.total_ttc), stampDuty: String(invoice.stamp_duty), withholdingAmount: String(invoice.withholding_amount), netPayable: String(invoice.net_payable) },
    };
  }
}

// Pas une signature électronique : simple empreinte, marquée « simulated ». Une vraie signature exigerait un certificat et un format imposés.
export class SimulatedSignatureAdapter extends ElectronicSignatureAdapter {
  async sign(payloadString) { return { status: 'simulated', signature: `SIMULATED-NOT-A-SIGNATURE:${sha256(payloadString)}` }; }
}

export class SimulationProvider extends TransmissionProvider {
  get id() { return 'simulation'; } get mode() { return 'simulation'; }
  async submit({ idempotencyKey, scenario }) {
    const reference = `SIM-${idempotencyKey.slice(0, 12).toUpperCase()}`; // déterministe : un renvoi avec la même clé renvoie la même référence (idempotence)
    if (scenario === 'network_error') throw new TransientProviderError('Délai d\'attente dépassé (erreur réseau simulée)');
    if (scenario === 'reject') return { outcome: 'rejected', reference, response: { simulated: true, code: 'SIM_REJECTED', message: 'Rejet simulé par le fournisseur de test' } };
    return { outcome: 'accepted', reference, response: { simulated: true, code: 'SIM_ACCEPTED', message: 'Accusé de réception simulé' } };
  }
  async getStatus({ reference }) { return { outcome: 'accepted', reference, response: { simulated: true, code: 'SIM_ACCEPTED' } }; }
}

// Emplacement réservé : AUCUNE intégration réelle n'est implémentée. Lève systématiquement une erreur explicite.
export class TtnProvider extends TransmissionProvider {
  get id() { return 'ttn'; } get mode() { return 'production'; }
  async submit() { throw new ProviderNotConfiguredError('Intégration TTN non implémentée : elle requiert les spécifications officielles, un certificat, des accès et une homologation.'); }
  async getStatus() { return this.submit(); }
}

export const PROVIDERS = { simulation: new SimulationProvider(), ttn: new TtnProvider() };
export const PROVIDER_INFO = [
  { id: 'simulation', label: 'Simulation (tests)', available: true, official: false },
  { id: 'ttn', label: 'TTN — Tunisie TradeNet', available: false, official: true, reason: 'Non implémenté : nécessite spécifications officielles, certificat de signature, identifiants et homologation.' },
];
