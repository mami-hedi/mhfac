# Phase 6 — Devis, factures, avoirs (cœur)

Périmètre validé : « cœur d'abord ». Livré : moteur de calcul testé, devis, factures, avoirs, timbre fiscal, retenue à la source, numérotation, PDF, paramètres de facturation. **Plus tard** : commandes client, bons de livraison, envoi par e-mail, factures d'acompte/solde, factures récurrentes, modèles PDF multiples (Phases 7-9).

## Fichiers
**Serveur** : `migrations/004_sales_documents.sql` (quotes, quote_lines, quote_tax_lines, invoices [+ avoirs via `kind`], invoice_lines, invoice_tax_lines) ; `src/core/calc.js` (moteur BigInt) ; `src/modules/sales/{common,quotes.routes,invoices.routes,invoices.service,preview.routes,pdf}.js` ; `src/modules/companies/settings.js` (paramètres de facturation) ; `tests/calc.test.js` (12), `tests/sales.test.js` (17).
**Client** : `features/sales/{DocListPage,DocEditorPage,DocViewPage,BillingSettings,shared}.jsx`, routes dans `App.jsx`, menu (Devis, Factures, Avoirs), section « Facturation » dans Paramètres.
**Test navigateur** : `docs/e2e/phase6_browser_test.py` (34 vérifications).

## Règles de calcul (centralisées dans `core/calc.js`, à faire valider par un comptable)
1. Net de ligne = quantité × prix HT × (1 − remise ligne %), arrondi au millime (demi supérieur).
2. Remise globale (%) appliquée à la base de chaque taux de TVA.
3. TVA = arrondi(base × taux %) **par base imposable** (pas ligne par ligne).
4. Total HT = Σ bases ; TVA = Σ TVA ; TTC = HT + TVA.
5. Timbre fiscal : montant fixe ajouté après le TTC, hors base de TVA et de retenue. **Désactivé et à 0 par défaut** : à paramétrer (Paramètres > Facturation).
6. Retenue à la source = arrondi(TTC × taux %), déduite du net à payer. Taux par défaut 0, saisi par document.
7. Net à payer = TTC + timbre − retenue. Arithmétique entière (BigInt), aucun flottant. Le serveur ignore tout total envoyé par le client.

## Cycles de vie
- **Devis** : brouillon → envoyé → accepté / refusé ; « expiré » dérivé de la date de validité ; accepté → converti en facture (brouillon, sans ressaisie). Modifiable uniquement en brouillon ; verrouillé une fois converti. Duplication possible. Numéro `DEV-AAAA-NNNNN`.
- **Facture** : brouillon (sans numéro, modifiable/supprimable) → **émise** (numéro `FAC-AAAA-NNNNN` attribué dans une transaction, document figé avec instantané client et société). Une facture émise ne se modifie ni ne se supprime. Annulation encadrée (motif obligatoire, numéro conservé, refus si règlement ou avoir). « Payée / partiellement payée / en retard » sont dérivés de `paid_amount` (alimenté en Phase 7) et de l'échéance.
- **Avoir** `AVO-AAAA-NNNNN` : lié à une facture émise, total cumulé plafonné au montant de la facture, réduit le solde restant.
- Numérotation continue par société, type et année ; refus d'une date antérieure au dernier document émis (ordre chronologique) ; pas de numéro consommé par un brouillon.
- Historique des modifications (`GET /:id/history`, depuis le journal d'audit).
- Devise étrangère : taux de change obligatoire, conservé sur le document.

## API (`/api/v1`)
`/quotes`, `/invoices`, `/credit-notes` : liste filtrée/paginée, détail, `PDF` (`/:id/pdf`), `history`. Devis : `POST`, `PUT /:id`, `POST /:id/status`, `/duplicate`, `/convert`, `DELETE`. Factures : `POST`, `PUT /:id`, `POST /:id/issue`, `/cancel`, `DELETE`. Avoirs : `POST` (depuis une facture, lignes partielles possibles), `POST /:id/issue`. `POST /sales/preview` : calcul serveur sans écriture (alimente l'écran). Permissions : `quote.*`, `invoice.*`, `credit_note.*` ; émettre exige `.validate` (le commercial rédige, le comptable/propriétaire émet).

## Installer / tester
```
cd server && npm install && npm run migrate   # applique 004 ; npm install ajoute pdfkit
npm test                                       # 71 tests
python3 docs/e2e/phase6_browser_test.py        # API :4000 + client :5173 démarrés
```
Nouvelle dépendance : `pdfkit`. Aucune nouvelle variable d'environnement.

## Réellement fait / limites
Fait : tout le périmètre « cœur » ci-dessus, vérifié par 71 tests serveur et 34 vérifications navigateur (dont immutabilité, concurrence de numérotation, isolation entre sociétés, mobile 390 px).
Limites : le PDF utilise les polices standard (texte latin/français ; pas d'arabe) et un seul modèle avec couleur d'accent et logo PNG/JPEG ; pas d'envoi par e-mail ; pas de facturation électronique TTN (adaptateur de simulation en Phase 8) ; le règlement des factures arrive en Phase 7 ; testé sur MariaDB 10.11 uniquement ; les taux de TVA, le timbre et la retenue sont des paramètres à valider avec votre comptable, rien n'est affirmé conforme.
