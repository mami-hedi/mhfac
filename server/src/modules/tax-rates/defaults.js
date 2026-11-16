// Taux proposes a la creation d'une entreprise. Ce sont des DONNEES modifiables (pas des constantes de calcul) :
// l'utilisateur peut les changer, les desactiver ou en ajouter. Valeurs indicatives, a valider avec un comptable.
export const DEFAULT_TAX_RATES = [
  { name: 'TVA 19 %', rate: '19.00', kind: 'standard', isDefault: 1 },
  { name: 'TVA 13 %', rate: '13.00', kind: 'standard', isDefault: 0 },
  { name: 'TVA 7 %', rate: '7.00', kind: 'standard', isDefault: 0 },
  { name: 'Exonéré (0 %)', rate: '0.00', kind: 'exempt', isDefault: 0 },
];
