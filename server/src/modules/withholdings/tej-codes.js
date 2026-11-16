// Codes d'opération TEJ (IdTypeOperation) et taux de droit commun — source : cahier des charges TEJ, septembre 2026 (§7.3.2.4).
// À revérifier à chaque nouvelle version du cahier des charges.
const c = (code, rate, label) => [code, { code, rate, label }];
export const OPERATION_CODES = Object.fromEntries([
  c('RS1_000001', '5.00', 'Loyers d\'hôtels (régime réel)'), c('RS1_000002', '10.00', 'Loyers servis à des résidents établis'),
  c('RS2_000001', '10.00', 'Honoraires BNC forfait d\'assiette, commissions, courtages'), c('RS2_000002', '3.00', 'Honoraires BNC régime réel (résidents établis)'),
  c('RS2_000003', '10.00', 'Rémunérations en contrepartie de la performance'), c('RS2_000004', '5.00', 'Artistes, créateurs, droits d\'auteur'), c('RS2_000005', '0.00', 'Honoraires BNC régime réel exonérés'),
  c('RS3_000001', '20.00', 'Revenus de capitaux mobiliers (résidents soumis)'), c('RS3_000002', '25.00', 'Revenus de capitaux mobiliers (résidents non soumis)'), c('RS3_000003', '20.00', 'Capitaux mobiliers non-résidents (hors banques)'),
  c('RS3_000004', '10.00', 'Capitaux mobiliers banques non établies'), c('RS3_000005', '25.00', 'Capitaux mobiliers — régime fiscal privilégié'),
  c('RS4_000001', '15.00', 'Cession de valeurs mobilières (personnes morales non résidentes)'), c('RS4_000002', '10.00', 'Cession de valeurs mobilières (personnes physiques non résidentes)'),
  c('RS5_000001', '10.00', 'Dividendes personnes physiques résidentes'), c('RS5_000002', '10.00', 'Dividendes non-résidents'), c('RS5_000003', '25.00', 'Dividendes — régime fiscal privilégié'),
  c('RS6_000001', '2.50', 'Cession de fonds de commerce'), c('RS6_000002', '2.50', 'Cession d\'immeubles (résidents)'), c('RS6_000003', '2.50', 'Cession d\'immeubles (personnes physiques non résidentes)'),
  c('RS6_000004', '2.50', 'Cession d\'immeubles (personnes physiques)'), c('RS6_000005', '10.00', 'Cession d\'immeubles (personnes morales non résidentes)'),
  c('RS7_000001', '1.50', 'Achats ≥ 1 000 DT TTC — fournisseur soumis à l\'IS (taux autre que 15 % et 10 %) ou personne physique'),
  c('RS7_000002', '1.00', 'Achats ≥ 1 000 DT TTC — fournisseur soumis à l\'IS à 15 %'), c('RS7_000003', '0.50', 'Achats ≥ 1 000 DT TTC — déduction 2/3 ou IS à 10 %'),
  c('RS7_000004', '1.50', 'Commissions distributeurs télécoms (personne physique)'), c('RS7_000005', '1.00', 'Commissions distributeurs télécoms (personne morale)'),
  c('RS7_000006', '0.00', 'Achats ≥ 1 000 DT TTC — fournisseur exonéré'), c('RS7_000007', '3.00', 'Paiements aux vendeurs en ligne par prestataires de livraison'),
  c('RS8_000001', '20.00', 'Jetons de présence (résidents)'), c('RS8_000002', '20.00', 'Jetons de présence (non-résidents)'), c('RS8_000003', '25.00', 'Jetons de présence — régime fiscal privilégié'),
  c('RS9_000001', '15.00', 'Rémunérations non-résidents non établis'), c('RS9_000002', '15.00', 'Redevances non-résidents non établis'), c('RS9_000003', '25.00', 'Résidents d\'un régime fiscal privilégié'),
  c('RS9_000004', '5.00', 'Non-résidents établis < 6 mois — construction'), c('RS9_000005', '10.00', 'Non-résidents établis < 6 mois — montage'), c('RS9_000006', '15.00', 'Non-résidents établis < 6 mois — autres services'),
  c('RS9_000007', '25.00', 'Non-résidents établis sans déclaration d\'existence (régime privilégié)'), c('RS9_000008', '25.00', 'Non-résidents établis sans déclaration d\'existence (autre)'),
  c('RS10_000004', '15.00', 'Travail occasionnel ou accidentel'), c('RS11_000001', '25.00', 'Jeux de pari et loterie'),
]);
export const isCode = (v) => Object.hasOwn(OPERATION_CODES, v);
