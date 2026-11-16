// Document FICTIF pour l'aperçu du modèle PDF dans les Paramètres (jamais enregistré, filigrane « EXEMPLE »).
export function sampleDocument(kind) {
  const names = ['Développement site vitrine (5 pages, responsive)', 'Hébergement annuel + nom de domaine', 'Formation de l\'équipe (demi-journée)'];
  const lines = [['1', 'forfait', '1800.000', '0', '19', '1800.000'], ['1', 'an', '250.000', '10', '19', '225.000'], ['2', 'u', '300.000', '0', '7', '600.000']]
    .map(([quantity, unit, unitPrice, discountPct, taxRate, netAmount], i) => ({ description: names[i], quantity, unit, unitPrice, discountPct, taxRate, netAmount }));
  const doc = {
    number: { invoice: 'FAC-2026-00042', quote: 'DEV-2026-00017', delivery_note: 'BL-2026-00009' }[kind] ?? 'EXEMPLE', status: 'issued', issueDate: '2026-01-15', dueDate: '2026-02-14', validUntil: '2026-02-14', deliveryDate: '2026-01-15',
    currency: 'TND', exchangeRate: '1', client: { name: 'Boulangerie Les Délices SARL', address: '12 avenue Habib Bourguiba', postalCode: '8000', governorate: 'Nabeul', taxId: '1234567/A/M/000' },
    lines, taxes: [{ taxRate: '19', base: '2025.000', amount: '384.750' }, { taxRate: '7', base: '600.000', amount: '42.000' }],
    subtotal: '2625.000', globalDiscountAmount: '0', totalHt: '2625.000', totalTax: '426.750', totalTtc: '3051.750', stampDuty: '1.000', withholdingAmount: '0', netPayable: '3052.750',
    paymentTermsDays: 30, notes: 'Merci pour votre confiance.', terms: '', deposits: [], deliveryAddress: 'Zone industrielle, Nabeul',
  };
  return doc;
}
