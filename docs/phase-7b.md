# Phase 7B — Retours, trésorerie, avances, relances

## Livré
- **Retours** : bons de retour client (depuis un BL validé, `BRT-`) et retours fournisseur (depuis une réception validée, `RF-`). La validation remet/retire le stock (mouvements `return_in` / `return_out`, au coût d'origine pour un retour client, au CMUP pour un retour fournisseur). Quantités plafonnées au restant retournable ; annulation = mouvement inverse ; l'annulation du BL/de la réception d'origine est bloquée (409 `HAS_RETURNS`). Le menu « Bons de sortie » liste les sorties de stock.
- **Trésorerie** : comptes (banque/caisse, devise, solde d'ouverture figé dès la première écriture), journal `TRS-AAAA-NNNNN`, écritures manuelles, virements internes (2 écritures liées, même devise), annulation avec motif (jamais de suppression), rapprochement manuel (case à cocher, solde rapproché distinct).
- **Chèques & traites** : un règlement par chèque/effet crée un instrument « en portefeuille » ; le compte n'est mouvementé qu'à l'encaissement. Remise en banque (reçus), encaissement/débit, impayé (annule le règlement lié, la facture redevient impayée). Un impayé est définitif.
- **Trop-perçus (avances)** : « Montant reçu » > total affecté → l'excédent reste non affecté ; affectation ultérieure (`POST /payments/:id/allocate`) ; avance pure sans facture possible. Même mécanisme côté fournisseur.
- **Relances clients** : factures émises en retard regroupées par client, e-mail de relance (sans PDF) avec la liste des factures et le total dû, journal `payment_reminders`, une relance / client / 24 h sauf confirmation (`force`), plafond 50/h.

## Décisions techniques
- Soldes calculés côté serveur en arithmétique entière signée (un solde peut être négatif) : `addSigned`.
- Le lien règlement ↔ trésorerie est dans `treasury.service.js` (`linkPayment` / `unlinkPayment`) ; `payments.factory.js` factorise règlements clients et fournisseurs.
- Annuler un règlement rapproché est refusé (409 `RECONCILED`) : il faut d'abord dé-rapprocher.
- Relances : montants lus en base ; le client ne fournit que le destinataire et un message optionnel.
- Aucune prétention de conformité TTN / facturation électronique.

## Migrations
`008_returns.sql`, `009_treasury.sql`, `010_reminders.sql` → `npm run migrate`.

## Tests
`cd server && npm test` (120 tests) ; navigateur : `python3 docs/e2e/phase7b_browser_test.py` (13 contrôles, API :4000 + Vite :5173).

## Cas limites
Devise du compte ≠ devise du règlement (422 `CURRENCY_MISMATCH`) ; écriture avant la date d'ouverture (422) ; écriture future refusée ; virement même compte (422) ; chèque encaissé deux fois (409) ; avance supérieure au solde de facture (422).

## Reste (Phase 7C)
Retenue à la source (listes ventes/achats, attestations), notes de débours, projets.
