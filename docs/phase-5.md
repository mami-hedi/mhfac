# Phase 5 — Clients, fournisseurs, articles, taux de TVA

## Fichiers créés / modifiés
**Serveur**
- `migrations/003_referentials.sql` : `document_sequences`, `tax_rates`, `product_categories`, `clients`, `suppliers`, `products` (+ taux proposés aux entreprises existantes).
- `src/core/` : `money.js` (décimaux en chaîne), `numbering.js` (numérotation atomique), `csv.js`, `list.js` (pagination/tri liste blanche), `refs.js` (références intra-société), `permissions.js` (+ `tax_rate.*`).
- `src/modules/parties/parties.js` (fabrique commune), `clients/`, `suppliers/`, `products/`, `product-categories/`, `tax-rates/`.
- `src/middlewares/error.js` (doublon MySQL → 409, FK → 409), `src/app.js` (montage), `modules/auth/auth.service.js` (taux proposés à l'inscription).
- `tests/masterdata.test.js` (9 tests), `tests/helpers.js` (réponses CSV).

**Client** : `features/masterdata/{PartiesPage,ClientsPage,SuppliersPage,ProductsPage,TaxRatesPage,shared}.jsx`, `App.jsx`, `config/nav.js`, `Sidebar.jsx`, `ui/index.jsx` (Modal large).
**Test navigateur** : `docs/e2e/phase5_browser_test.py` (31 vérifications).

## API (`/api/v1`, jeton requis)
| Ressource | Routes | Permissions |
| --- | --- | --- |
| `/clients`, `/suppliers` | `GET /` (q, status, page, limit, sort, order), `GET /export.csv`, `POST /import`, `POST /`, `GET/PATCH/DELETE /:id` | `client.*` / `supplier.*` |
| `/products` | idem + filtres `type`, `categoryId` | `product.*` |
| `/product-categories` | `GET`, `POST`, `PATCH/:id`, `DELETE/:id` | `product.*` |
| `/tax-rates` | `GET`, `POST`, `PATCH/:id`, `DELETE/:id` | `tax_rate.*` |

Listes : `{ data, meta:{page,limit,total,pages} }`. Import CSV : corps `{csv, dryRun, skipInvalid}` ; `dryRun` ne crée rien ; sans `skipInvalid`, une ligne en erreur annule tout (422).

## Décisions techniques
- **Taux de TVA = données par entreprise**, jamais constantes de calcul. 4 taux indicatifs (19/13/7/exonéré) sont proposés à la création (à faire valider par un comptable). Exonéré/suspendu imposent 0 %. Un seul taux par défaut ; le défaut ne peut être ni supprimé ni désactivé ; un taux utilisé ne peut pas être supprimé (409) ; un taux inactif n'est plus assignable.
- **Codes** `CLI-00001`, `FOU-00001`, `ART-00001` : upsert `LAST_INSERT_ID` sur `document_sequences` dans la transaction (verrou de ligne : pas de doublon sous concurrence, pas de trou si annulation). Testé avec 8 créations simultanées. (Un premier essai `INSERT IGNORE` + `FOR UPDATE` provoquait des deadlocks : abandonné.)
- **Montants** : acceptés en chaîne/nombre (`12,5` ok), refus au-delà de 3 décimales, stockés `DECIMAL(15,3)`, renvoyés en chaîne ; aucun calcul en flottant.
- **Anti-IDOR** : tout filtré par `company_id` de la session ; une référence (catégorie, taux) d'une autre société est refusée (422), une ressource d'une autre société répond 404.
- **Suppression** : physique uniquement si rien n'y est rattaché (FK → 409) ; sinon archivage (réversible). Archivé = exclu des listes par défaut. Journal d'audit sur création, modification, archivage, suppression, import, export.
- **Export CSV** : même permission de lecture, limité à la société, 10 000 lignes max, journalisé, neutralisation des formules (`=`, `+`, `-`, `@`). Import : 1000 lignes / ~900 Ko max, séparateur détecté, en-têtes FR/EN.
- Matricule fiscal unique par société (clients et fournisseurs) ; format volontairement permissif (non vérifié contre un registre).
- Service : suivi de stock forcé à non.

## Lancer / tester
```
cd server && npm run migrate        # applique 003 (+ taux proposés aux entreprises existantes)
npm test                            # 42 tests
cd ../client && npm run dev
# test navigateur (API :4000 + client :5173 démarrés) :
python3 docs/e2e/phase5_browser_test.py
```
Dépendances / variables d'environnement : aucune nouvelle.

## Cas limites vérifiés
Doublon de matricule/SKU, mêmes valeurs dans deux sociétés, recherche avec `%`, tri hors liste blanche, UUID invalide (400), accès croisé (404), rôles lecture seule/commercial, CSV avec guillemets/virgule, lignes en erreur, ré-import (doublons rejetés), création concurrente, injection de formule à l'export, mobile 390 px.

## Réellement fait / reste à faire
Fait : CRUD complet, validations, recherche, filtres, pagination, archivage, import/export CSV, catégories, taux de TVA configurables, permissions, isolation, audit, UI.
Pas encore : fiche détaillée client avec solde/historique (documents en Phase 6), plusieurs adresses/contacts, prix par client, TVA par client (exonération client), tri cliquable dans l'interface, mise à jour du stock (Phase 7), testé uniquement sur MariaDB 10.11 (pas MySQL 8), pas de tests unitaires côté client.
