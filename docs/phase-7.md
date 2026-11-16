# Phase 7 — Achats, paiements fournisseurs et stock (cœur)

Périmètre validé : « cœur d'abord ». **Fait** : achats (commande, réception, facture d'achat, avoir fournisseur), règlements fournisseur, stock de base (entrepôts, mouvements, bons d'entrée/sortie/transfert, fiches d'inventaire), sortie de stock par les bons de livraison de vente.
**Pas fait (phases suivantes)** : comptes de trésorerie et chèques/traites, module retenue à la source, notes de débours, projets, retours (client et fournisseur), PDF des réceptions / factures d'achat / avoirs fournisseur (seul le bon de commande fournisseur a un PDF et un envoi e-mail).

## Parcours
Commande fournisseur `BCF-AAAA-NNNNN` (brouillon → confirmée, numéro attribué à la confirmation, figée) → réception(s) `BR-AAAA-NNNNN` (partielles possibles, plafonnées au reste à recevoir) → facture d'achat (saisie du document du fournisseur, enregistrée avec un numéro interne `FA-AAAA-NNNNN`) → règlement(s) `RGF-AAAA-NNNNN`. Avoir fournisseur `AVF-AAAA-NNNNN` sur une facture enregistrée.

## Décisions techniques
- **Le stock entre uniquement par les réceptions** (et les bons d'entrée). Une facture d'achat ou un avoir ne bouge jamais le stock : évite le double comptage.
- **Valorisation CMUP** (coût moyen pondéré). Une réception entre au coût net de la commande (remise de ligne et remise globale déduites, taux de change appliqué), 4 décimales.
- **Annulation d'une réception** : mouvement inverse (`cancellation`) ; refusée si une facture d'achat active la couvre. Validation idempotente (clé unique source/ligne/type) et verrouillage de lignes de stock.
- **Stock négatif autorisé par défaut** (réglage `stock.allowNegative`, modifiable dans les paramètres) ; sinon `STOCK_INSUFFICIENT`.
- **N° du document fournisseur obligatoire et unique** par fournisseur et par nature (facture / avoir), hors documents annulés → `409 DUPLICATE_SUPPLIER_REF`. Le numéro interne n'est attribué qu'à l'enregistrement (numérotation continue, sans trou).
- **Facture enregistrée figée** : ni modification ni suppression ; annulation motivée, refusée s'il existe des règlements ou avoirs. L'annulation libère la réception pour une nouvelle facture.
- **Avoirs** : plafonnés par ligne (reste créditable) et au total de la facture, y compris le cumul des avoirs.
- **Règlements** : affectation à une ou plusieurs factures du même fournisseur et de même devise ; sur-paiement refusé (solde = net − réglé − avoirs) ; factures verrouillées pour sérialiser les paiements simultanés ; annulation conservée avec motif.
- Totaux, TVA, remises, statuts et droits sont calculés **côté serveur** (moteur `core/calc.js`, montants en DECIMAL) ; aperçu via `POST /purchases/preview`. `company_id` vient toujours de la session ; document d'une autre société → 404.
- Pas de timbre ni de retenue à la source appliqués par défaut aux achats (retenue : module dédié plus tard).

- **Création rapide** (Achats **et Ventes**) : dans les éditeurs de commande/facture d'achat, « + Nouveau fournisseur » et « + Nouvel article » (sur chaque ligne) ; dans les éditeurs de devis/commande/facture de vente, « + Nouveau client » et « + Nouvel article » créent la fiche sans quitter le document et la sélectionnent aussitôt. Visible seulement avec les droits `supplier.write` / `client.write` / `product.write` ; les fiches se complètent ensuite dans Fournisseurs / Articles.

## API (préfixe `/api/v1`)
`/purchase-orders`, `/purchase-receipts`, `/purchase-invoices` (+ `/from-order/:id`, `/from-receipt/:id`, `/:id/record`, `/:id/cancel`), `/purchase-credit-notes`, `/supplier-payments`, `/purchases/preview`. Permissions : `purchase.*`, `purchase_receipt.*`, `payment.*`.

## Tester
- Serveur : `cd server && npm test` (109 tests, dont `tests/purchases.test.js` et `tests/stock.test.js`).
- Navigateur : API sur :4000 (log dans `api.log`) + `npm run dev` du client, puis `python3 docs/e2e/phase7_browser_test.py` (26 contrôles : parcours complet, stock, doublon, lecture seule).
- Migration : `cd server && npm run migrate` (applique `006_stock.sql` et `007_purchases.sql`).

## Cas limites couverts
Réception au-delà du reste (422), double validation (409), annulation d'une réception facturée (409), doublon de n° fournisseur, avoir au-delà du créditable, sur-paiement, annulation de facture avec règlement/avoir, isolation entre sociétés, rôle lecture seule (403), commande verrouillée après confirmation.
