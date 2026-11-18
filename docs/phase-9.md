# Phase 9 — Abonnements, sécurité et finition

## 9A — Abonnements SaaS et administration de la plateforme
- **Offres, limites et fonctionnalités sont en base** (`subscription_plans`), jamais dans le code. Aucun prix n'est codé : un prix `NULL` s'affiche « sur demande ». Les trois offres livrées (`decouverte`, `auto_entrepreneur`, `business`) ont des limites **indicatives** à ajuster par le super administrateur.
- Limites : `users`, `invoicesPerMonth`, `warehouses`, `scansPerMonth`, `exportsPerMonth` (`null` = illimité). Fonctionnalités : `einvoice`, `purchaseScan`, `reportsExport`, plus un texte de support.
- Statuts effectifs : `trial`, `active`, `past_due`, `cancelled`, `expired`. **Expiré/résilié = lecture seule** : écritures refusées (403 `SUBSCRIPTION_INACTIVE`), lecture et exports restent possibles, `/auth` et `/subscription` restent utilisables. L'accès aux données n'est jamais coupé.
- Dépassement : 403 `PLAN_LIMIT_REACHED` ; fonctionnalité hors offre : 403 `FEATURE_NOT_IN_PLAN`. La vérification de limite verrouille la ligne d'abonnement (`FOR UPDATE`) pour éviter qu'un envoi simultané dépasse le plafond.
- **Super administrateur** (`users.is_platform_admin`, lu en base à chaque requête, jamais depuis le jeton) : gère offres, entreprises, abonnements, suspension/réactivation (motif ≥ 5 caractères, journalisé). **Il n'a aucun accès aux données métier** des entreprises. Création : `npm run create-admin`.
- **Pas de paiement en ligne** : l'interface le dit explicitement ; le changement d'offre est manuel. Refus de rétrograder une entreprise sous son usage actuel (409 `USAGE_EXCEEDS_PLAN`).

## 9A bis — Tarification et essai gratuit (demande du 1er novembre)
- **Offre standard « Pro » : 56 TND / mois ou 560 TND / an** (= 2 mois offerts : 12 × 56 = 672, soit 112 TND d'économie). Prix stockés en base (`price_monthly`, `price_yearly`, migration 016) et modifiables dans l'espace plateforme ; « mois offerts » est calculé à partir des deux prix, jamais saisi.
- **14 jours d'essai gratuits** à l'inscription (`TRIAL_DAYS=14`, 0 = pas d'essai) sur le plan `DEFAULT_PLAN_CODE` (désormais `pro`). Pendant l'essai : toutes les fonctionnalités du plan, sans carte ni paiement. Fin d'essai = fin du 14ᵉ jour ; ensuite **lecture seule** (consultation et exports possibles) jusqu'à activation par l'administrateur. « Mon abonnement » affiche le décompte des jours restants (calculé par le serveur).
- Périodicité convenue (mensuelle/annuelle) enregistrée par l'administrateur avec l'échéance : information de suivi.
- **Décisions à connaître** : (1) le prix est porté par l'offre Pro (5 utilisateurs, 300 factures/mois, 3 entrepôts : limites indicatives) ; Découverte, Auto-entrepreneur et Business restent « sur demande » ; (2) **aucun paiement en ligne** : le règlement (virement, espèces…) est suivi hors de MHFac et l'administrateur active l'abonnement et fixe l'échéance ; (3) pas de rappel automatique par e-mail avant la fin d'essai ; (4) les entreprises créées avant cette évolution gardent leur plan actuel (aucun essai rétroactif) ; (5) les prix sont hors/avec taxes selon votre choix commercial : MHFac n'applique aucune TVA sur ces montants.

## 9A ter — Paiement par virement bancaire et rappel de fin d'essai (demande du 1er novembre)
**Paiement : toujours aucun paiement en ligne.** Le règlement se fait par virement ; MHFac guide le client, enregistre sa déclaration, et laisse l'administrateur confirmer après vérification de son relevé.
1. **Coordonnées bancaires de l'éditeur** (table `platform_payment_info`, une seule ligne) : bénéficiaire, banque, RIB, IBAN, BIC, contact, consignes. Modifiables dans *Plateforme → Paiements*. Les valeurs livrées sont des **valeurs de remplacement** (« À COMPLÉTER », RIB à zéros) : tant que vous n'avez pas enregistré vos vraies coordonnées, les entreprises **ne voient rien** et ne peuvent pas déclarer de paiement. Le serveur refuse d'enregistrer des valeurs de remplacement, un RIB qui n'a pas 20 chiffres, un IBAN dont la clé de contrôle (modulo 97) est fausse ou qui ne correspond pas au RIB, et un BIC mal formé. La clé du RIB elle-même n'est pas vérifiée (aucune banque n'est interrogée) : relisez-la.
2. **Côté client** (*Mon abonnement → Passer au paiement*, `/subscription/pay`) : choix mensuel/annuel, montant affiché (calculé par le serveur), coordonnées avec boutons « copier », **référence de virement** `MHFAC-XXXXXXXX` propre à l'entreprise, puis formulaire « J'ai effectué le virement » (référence, date, remarque) et historique. Le client ne peut envoyer ni montant ni offre (refusé par le serveur) ; une seule déclaration en attente à la fois ; date future refusée ; réservé au propriétaire (`subscription.write`). Possible même quand l'abonnement est expiré (lecture seule).
3. **Côté plateforme** : liste des déclarations (filtre par statut, compteur « Paiements à vérifier » sur la vue d'ensemble). **Confirmer** exige de ressaisir le **montant réellement reçu**, qui doit être égal au montant attendu (sinon 422 `AMOUNT_MISMATCH` : rejetez avec un motif) ; l'abonnement passe à *Actif*, la périodicité est enregistrée et l'échéance calculée : à partir d'aujourd'hui, ou de l'échéance en cours si l'abonnement court encore (aucun jour payé n'est perdu ; fin de mois ramenée au dernier jour). **Rejeter** exige un motif (≥ 5 caractères), envoyé par e-mail au client. Un paiement ne peut être traité qu'une fois (409 `ALREADY_PROCESSED`). Chaque étape est journalisée (le RIB complet n'est pas copié dans le journal d'audit) ; le client reçoit un e-mail de confirmation.
4. **Rappel de fin d'essai** : au **12ᵉ jour** de l'essai (`TRIAL_REMINDER_DAY=12`, soit 2 jours avant la fin d'un essai de 14 jours), un e-mail est envoyé au(x) propriétaire(s) : date de fin, prix, lien vers la page de paiement, rappel du passage en lecture seule. **Une seule fois** par essai (le marqueur est posé avant l'envoi : pas de doublon, même avec deux instances) ; jamais pour un essai déjà échu ; en cas d'échec d'envoi il est retenté à l'heure suivante ; si l'administrateur modifie la date de fin d'essai, un nouveau rappel redevient possible. Vérification toutes les heures (même interrupteur que les factures récurrentes : `RECURRING_SCHEDULER`). L'e-mail ne contient aucune coordonnée bancaire, uniquement le lien.
- **Prérequis pour que le rappel parte réellement** : `MAIL_PROVIDER=smtp` et les variables `SMTP_*` renseignées, et `CLIENT_URL` = adresse publique du site (elle sert à construire le lien). Avec `MAIL_PROVIDER=console` (défaut de développement) les e-mails sont seulement affichés dans les journaux de l'API.
- **Limites** : la vérification du virement est manuelle (pas de rapprochement bancaire automatique) ; pas de facture/reçu d'abonnement généré ; pas de second rappel après la fin de l'essai ni avant l'échéance d'un abonnement payant ; pas de remboursement géré dans l'application.

## 9A quater — Corrections : logo et timbre fiscal (2 novembre)
**Logo (Paramètres → Logo et couleur)** — causes trouvées en reproduisant le problème dans le navigateur :
1. choisir un fichier ne faisait qu'un aperçu local : l'enregistrement dépendait du bouton « Enregistrer » tout en bas d'une longue page, et le bouton « Enregistrer » du haut (identité de l'entreprise) est un autre formulaire qui ne touche pas au logo ;
2. un logo de plus de 250 Ko était refusé, et le message d'erreur s'affichait en haut de la page, hors de vue : l'utilisateur ne voyait rien ;
3. le formulaire fiscal renvoyait aussi le logo chargé à l'ouverture de la page : il pouvait réécraser un logo plus récent.
Correctif : la carte « Logo et couleur » est autonome. Le logo est **enregistré dès qu'il est choisi** (et dès qu'on clique « Retirer »), avec le résultat affiché dans la carte ; la couleur, le modèle et la langue ont leur propre bouton. Le navigateur **réduit et compresse** l'image avant l'envoi (jusqu'à 8 Mo acceptés ; PNG, JPEG ou WebP ; transparence conservée), donc un vrai logo passe sans retouche. Le formulaire fiscal n'envoie plus le logo. Le formulaire de facturation a maintenant une barre d'enregistrement toujours visible avec le message à côté du bouton. Le serveur revérifie que le fichier est un vrai PNG/JPEG (premiers octets) : un fichier HTML ou SVG déguisé est refusé.

**Timbre fiscal facultatif** — constat : côté **ventes** le timbre était déjà décochable (l'API et l'écran le respectaient) mais pré-coché quand le réglage par défaut est activé, avec un libellé qui ne disait pas qu'il est facultatif ; côté **achats** il n'existait **aucune** commande de timbre (impossible d'en saisir un quand le fournisseur en facture un). Correctif :
- Achats : case « Cette facture comporte un timbre fiscal (facultatif) » + **montant propre à chaque facture** (celui du fournisseur ; vide = montant des paramètres), validé par le serveur (≤ 3 décimales, refus des valeurs négatives ou absurdes), conservé à l'enregistrement, retirable en modifiant le brouillon ; aperçu et fiche affichent le timbre et le net à payer.
- Ventes : libellé « (facultatif) » avec le montant, avertissement si le montant des paramètres est à 0, réglage renommé « Pré-cocher… (jamais obligatoire) ». Le montant d'une vente vient toujours des paramètres : le client ne peut pas en imposer un autre.
- Scan de facture fournisseur : le timbre lu sur le document pré-remplit la case (modifiable).
- **Si vous aviez constaté un timbre « obligatoire » dans un autre cas, envoyez-moi le document concerné** : tous les chemins connus (devis, commandes, bons de livraison, factures récurrentes, avoirs) ont été relus et aucun n'impose le timbre.

## 9B — Sécurité, permissions, performance
- **En-têtes** : `helmet`. **CORS** : liste blanche `CLIENT_URL`. **Limitation de débit** globale (`API_RATE_LIMIT_PER_MIN`) + spécifique `/auth` (`AUTH_RATE_LIMIT_MAX`) + verrouillage de compte après échecs (`LOGIN_MAX_FAILURES`/`LOGIN_LOCK_MINUTES`).
- **CSRF** : sans objet pour l'API (jeton Bearer en en-tête, non automatique). Le seul cookie, de rafraîchissement, est `httpOnly`, `SameSite=strict`, limité au chemin `/api/v1/auth`, `Secure` en production. Aucun jeton n'est stocké en `localStorage` pour des données métier.
- **Injection** : requêtes paramétrées uniquement ; validation `zod` de toute entrée ; exports CSV neutralisent les formules.
- **Erreurs** : JSON invalide → 400 `INVALID_JSON` (corrigé en Phase 9 : renvoyait 500), corps trop gros → 413, encodage non supporté → 415 ; les détails internes sont masqués en production.
- **Matrice des permissions** visible dans l'application (Équipe → droits par rôle) et via `GET /users/permissions-matrix` ; source unique `core/permissions.js`.
- **Suite de sécurité automatique** (`tests/security.test.js`, 13 tests) qui parcourt **toutes** les routes réelles (≈300) : aucune route métier n'est accessible sans authentification (401) ; jeton falsifié → 401 partout ; un rôle lecture seule ne peut écrire sur aucune route d'écriture (403) ; l'espace plateforme est fermé à tout compte non super administrateur ; aucun `GET /:id` d'une autre entreprise ne renvoie 200 ni 500 ; entrées malveillantes (injection SQL, XSS, chaînes très longues, types inattendus) → jamais d'erreur 500 ; `company_id`, totaux et statut envoyés par le client sont ignorés ; en-têtes de sécurité, CORS et cookie ; verrouillage après échecs de connexion sans révéler l'existence du compte ; aucun secret dans le journal d'audit ; aucune pile d'appels ni SQL dans les erreurs ; matrice des droits cohérente avec l'application.
- **Performance** mesurée sur ~20 000 factures émises (base locale MariaDB, une seule société) : liste 0,3 s, recherche 0,2 s, impayées 0,3 s, tableau de bord 0,5 s, rapport ventes 0,4 s, créances âgées 0,3 s, relances 0,5 s. Aucun index supplémentaire n'a été nécessaire. Ces chiffres sont indicatifs (machine de développement), pas une garantie de production.

## 9C — Documentation et livraison
- `README.md` (démarrage), `docs/DEPLOIEMENT.md` (installation Windows, production, sauvegarde/restauration, limites e-invoicing), `docs/API.md` (**générée** depuis les routes réelles : `npm run docs:api`, 322 routes), `docs/phase-*.md` (décisions par phase), `server/.env.example`, `server/.env.test.example`, `client/.env.example`.
- `npm run seed-demo` : entreprise **fictive** créée via l'API publique (mêmes règles que l'application) ; refuse `NODE_ENV=production`.
- `npm run backup` / `npm run restore -- <fichier> --yes` : sauvegarde `.sql.gz` avec purge, restauration protégée par confirmation ; aller-retour vérifié.

## 9D — Notifications (cloche, page « Mes notifications », préférences)
**Choix validés avec vous** : événements = ventes, stock/achats, abonnement ; canal = dans l'application uniquement ; destinataires selon le rôle ; préférences par utilisateur.

- **Quoi** (10 types) : factures clients en retard (1 notification groupée par semaine, pas une par facture) ; factures clients échues sous 3 jours ; encaissement enregistré (48 h) ; factures fournisseurs échues / à payer sous 3 jours ; articles sous le seuil d'alerte ; stock négatif ; fin d'essai (≤ 3 jours) ; abonnement bientôt expiré (≤ 7 jours) ; abonnement/essai expiré ; paiement d'abonnement confirmé ou refusé (avec le motif).
- **Qui** : par PERMISSION, donc par rôle — celle de l'action à mener : factures clients → `invoice.write` (propriétaire, administrateur, comptable, commercial) ; encaissements → `payment.write` ; fournisseurs → `purchase.write` ; stock → `stock.write` (dont gestionnaire de stock) ; abonnement → `subscription.read` (propriétaire et administrateur). Le rôle lecture seule ne reçoit rien (rien à faire). Le statut lu / non lu est personnel.
- **Comment** : l'analyse d'une entreprise tourne quand quelqu'un ouvre la cloche ou la page (au plus 1 fois / 5 min / entreprise) et, en plus, toutes les heures si `RECURRING_SCHEDULER=on`. Idempotente : clé unique (entreprise, utilisateur, clé de déduplication) → aucun doublon, même si l'analyse est rejouée. Les situations qui durent sont regroupées (un jeu d'articles ou de factures = une clé) ; une alerte de stock bas se représente au plus 1 fois par mois tant que le jeu d'articles ne change pas.
- **Préférences** : `GET/PUT /notifications/preferences` ; seuls les types permis par le rôle sont proposés et acceptés (422 sinon). Un type désactivé est masqué (liste ET compteur) ; réactivé, l'historique réapparaît. Les préférences sont propres à l'utilisateur ET à l'entreprise.
- **Sécurité** : tout est filtré par l'entreprise et l'utilisateur de la SESSION ; la notification d'un autre utilisateur ou d'une autre entreprise est introuvable (404). Le lien d'une notification est toujours une route interne du client. Marquer comme lu reste possible même si l'abonnement est expiré (route exemptée du blocage lecture seule, car aucune donnée métier n'est touchée) ; le test générique « lecture seule = aucune écriture » exclut explicitement `/notifications` pour cette raison.
- **Rétention** : les notifications lues sont purgées après 60 jours, toutes après 180 jours (passage horaire).
- **Client** : cloche avec pastille (rafraîchie chaque minute et au retour sur l'onglet), 6 dernières, « tout marquer comme lu » ; page `/notifications` (toutes / non lues, « Afficher plus ») ; onglet Préférences groupé par catégorie ; entrée « Mes notifications » dans le menu du profil.
- **Fichiers** : `migrations/018_notifications.sql`, `modules/notifications/{notifications.service,notifications.routes}.js`, `tests/notifications.test.js` (8 tests), `client/src/features/notifications/*`, `layouts/Header.jsx`, `docs/e2e/phase9_notifications_test.py` (11 contrôles navigateur, dont mobile 390 px).
- **Limites** : pas d'e-mail, SMS ni WhatsApp (à brancher plus tard sur le même service `notify()`) ; pas de temps réel (rafraîchissement toutes les minutes) ; les seuils (3 jours, 7 jours, 48 h) sont fixes, non paramétrables ; les montants ne sont pas additionnés entre devises (les notifications groupées indiquent un nombre, pas un total).

## Fichiers créés / modifiés
Migrations `014_purchase_invoice_stock_entry.sql`, `015_subscriptions.sql`, `016_pricing_trial.sql`, `017_payments_reminders.sql`, `018_notifications.sql` ; `core/plan.js`, `middlewares/platformAuth.js`, `modules/{subscription,platform}`, `middlewares/{auth,error}.js` ; `scripts/{create-platform-admin,seed-demo,backup,restore,gen-api-docs}.js` ; client : pages Abonnement, Plateforme, droits par rôle ; tests `subscription`, `security`, `helpers_routes` ; docs ci-dessus.

## Comment tester
`cd server && npm test` (174 tests). E2E navigateur : `docs/e2e/phase9a_browser_test.py`. Voir `docs/DEPLOIEMENT.md` §2.

## Limites connues (honnêtes)
- Limites des offres = valeurs de départ à valider ; aucun tarif défini.
- Pas de paiement en ligne. Les notifications sont dans l'application uniquement (cloche) : pas d'e-mail ni de WhatsApp, hors le rappel de fin d'essai.
- Facturation électronique = simulation non homologuée TTN (voir `docs/DEPLOIEMENT.md` §6).
- Le scan n'a été testé que sur des factures générées, pas sur de vraies factures de fournisseurs tunisiens : à valider avec vos documents.
- Performance mesurée sur une seule entreprise et une machine de développement ; à re-mesurer sur l'infrastructure réelle.
- Pas de tests de charge concurrente ni d'audit de sécurité externe : la suite automatique ne remplace pas un test d'intrusion avant une ouverture publique.

## 9E — Factures directes et logistique, modèle PDF « Classique pro »

### Règle d'or : une marchandise ne bouge qu'une seule fois
Deux chemins, jamais les deux (le serveur l'impose) :
| Cas | Qui fait bouger le stock |
|---|---|
| Facture de vente **directe** avec « Sortir du stock à l'émission » | la facture, à l'émission (mouvement `delivery`, source `invoice`) |
| Facture de vente directe **sans** la case, puis « Générer un BL » | le BL, à sa validation |
| Facture avec la case **puis** « Générer un BL » | le BL est un simple document (`stock_impact = 0`), aucun second mouvement |
| Facture d'achat directe avec « Entrer en stock » (existait déjà, migration 014) | la facture, à l'enregistrement |
| Facture d'achat directe **sans** la case, puis « Générer un BR » | le BR, à sa validation, au coût de la facture (remise globale et change inclus) |
| Facture d'achat avec la case | « Générer un BR » refusé : `ALREADY_IN_STOCK` |

### Migration 019
`invoices.stock_exit / stock_warehouse_id` ; `delivery_notes` et `purchase_receipts` : `order_id` devient facultatif + `source_invoice_id` (+ `stock_impact` côté BL) ; lignes : `order_line_id` facultatif + `invoice_line_id` + `product_id`.

### Routes ajoutées
- `POST /invoices/stock-check` : disponibilité indicative par article (aucune écriture).
- `POST /invoices/:id/delivery-note` : crée un BL **brouillon** pré-rempli (services exclus), lié à la facture.
- `POST /purchase-invoices/:id/receipt` : crée un BR **brouillon** pré-rempli, lié à la facture d'achat.
- `POST /sales/sample-pdf` : aperçu PDF d'un document fictif (couleur et langue en cours d'édition).

### Garde-fous
- Émission atomique : si le stock est insuffisant (réglage « stock négatif interdit »), la facture reste brouillon, sans numéro (`STOCK_INSUFFICIENT`).
- Facture issue d'une commande ou d'un BL : l'option de sortie est refusée (`STOCK_EXIT_NOT_ALLOWED`).
- Un seul BL / BR actif par facture ; la facture ne peut pas être annulée tant qu'il existe (`HAS_DELIVERY_NOTE`, `HAS_RECEIPT`). Annuler la facture avec sortie de stock restitue le stock (mouvement inverse).
- BL/BR issus d'une facture : lignes non modifiables (elles suivent la facture) ; pas de retour client/fournisseur (`RETURN_NOT_SUPPORTED`) : utiliser un avoir ou une régularisation de stock ; pas de « facturer ce BL » (`SOURCE_IS_INVOICE`).
- Droits : sortie de stock = `delivery.validate` ; générer un BL = `delivery.write` ; générer un BR = `purchase_receipt.write`.

### Limites connues
- Le contrôle de disponibilité obéit au réglage `stock.allowNegative` (autorisé par défaut) ; l'écran affiche un avertissement dans les deux cas.
- Un avoir ne remet pas en stock.
- Montant en lettres arabe : dinar tunisien seulement, à faire relire par un arabophone.

### Modèle PDF unique « Classique pro »
Pied de page fixe (nom, MF, RC, adresse, pagination), montant en lettres, récapitulatif de TVA par taux ; devis : validité + « Bon pour accord » ; BL : sans prix, signatures livreur / client. Les anciens réglages `modern`/`minimal` sont acceptés mais ignorés. Aperçu en direct dans Paramètres.

Tests : `tests/direct_logistics.test.js` (7), `tests/words.test.js` (3).

## 9F — Filtres, pagination et export CSV des listes (lot 1 : factures de vente, factures d'achat, stock)

### Règles communes
- **15 lignes par page** partout (défaut serveur `PAGE_SIZE`, plafond 100).
- **Tri par défaut : date décroissante** (les plus récents en haut), départagé par l'identifiant ; les en-têtes restent triables (liste blanche de colonnes).
- **Panneau de filtres commun** (`client/src/components/ListFilters.jsx`) : champs principaux sur une ligne (client/fournisseur, date de début, date de fin, statut, règlement) + filtres avancés dépliables (recherche avancée, montant min/max TTC, projet, produit) + « Réinitialiser » + « Exporter CSV ».
- **Les filtres vivent dans l'adresse de la page** (`?status=issued&from=2026-01-01`) : rechargement, retour arrière et partage conservent la vue.
- Le filtre projet / produit n'apparaît que si l'utilisateur peut lire les projets / articles.

### Filtres serveur (factures de vente, avoirs, factures d'achat, avoirs fournisseur)
| Paramètre | Effet |
|---|---|
| `from`, `to` | date du document (début > fin → 422) |
| `minAmount`, `maxAmount` | Total TTC (comparaison DECIMAL, min > max → 422) |
| `projectId` | documents rattachés au projet (projet d'une autre entreprise → aucun résultat) |
| `productId` | documents contenant ce produit dans leurs lignes |
| `q` | **recherche avancée** : numéro, tiers, n° fournisseur, notes ET désignations des lignes |

Tout est paramétré (aucune valeur du client dans le SQL) et limité à l'entreprise de la session.

### Export CSV
`GET /invoices/export`, `/credit-notes/export`, `/purchase-invoices/export`, `/purchase-credit-notes/export`, `/stock/movements/export`, `/stock/levels/export` : **mêmes paramètres que la liste**, sans pagination, plafonné à 5 000 lignes (`X-Export-Truncated: 1` si coupé). Format Excel français : séparateur `;`, UTF-8 avec BOM, dates JJ/MM/AAAA, montants à 3 décimales **avec virgule décimale**, cellules commençant par `= + - @` neutralisées (injection de formule). Droit de lecture du module exigé ; chaque export est tracé dans le journal d'audit.

### Lot 2 (à venir)
Devis, commandes, BL, BR, achats (commandes), retours, bons de stock, inventaires, règlements, notes de frais, projets, clients/fournisseurs/articles : filtres de période et de montant côté serveur, panneau commun, export, pagination à 15.

Tests : `tests/list_filters.test.js` (5).

### 9F — Lot 2 : le reste des modules

Même panneau de filtres (`ListFilters`), 15 lignes par page, tri par date décroissante et export CSV (`GET …/export`, `;`, BOM UTF-8, virgule décimale, plafond 5 000 lignes, audit `*.export`) pour : devis, commandes client, bons de livraison, commandes d'achat, bons de réception, bons de stock (entrées, sorties, transferts), retours clients/fournisseurs, notes de frais. Règlements clients/fournisseurs : filtres période et montant côté serveur, bouton « Exporter » (respecte les filtres en cours).

Décisions et limites :
- Montants filtrés sur le TTC ; Projet/Produit uniquement là où ils existent.
- Le filtre Produit des BL/BR retrouve aussi les lignes créées depuis une commande (produit lu via la ligne de commande) — bug corrigé pendant les tests.
- Pages Clients, Fournisseurs, Produits, Trésorerie, Projets, Retenues : filtres existants conservés, seule la pagination passe à 15.
- Export synchrone, plafonné à 5 000 lignes (en-tête `X-Export-Truncated` si dépassé). La recherche avancée (EXISTS sur les lignes + LIKE) est adaptée à quelques milliers de documents ; prévoir un EXPLAIN/index avant de grosses volumétries.
- `docs/API.md` : le générateur ne liste pas les routes déclarées avec un tableau de chemins (`['/', '/export']`).
- Tests : `list_filters2.test.js` (3 tests). Total 192. Trois tests de notifications/rappels peuvent échouer entre 00:00 et 01:00 (heure de Tunis, frontière UTC) : les relancer après 01:00.

## 9G — Préparation TEJ et génération du XML (retenue à la source)

Source : cahier des charges TEJ « dépôt de fichier des certificats de retenue à la source », septembre 2026 (64 p.).

Page Retenues › Achats : carte « Préparation de la déclaration TEJ » (`GET /withholdings/purchases/tej-prep?month=AAAA-MM`, `/export` CSV, `/xml`, `PUT /withholdings/purchases/:id/tej-operation`, `GET /withholdings/tej/codes` ; lecture `withholding.read`, écriture `withholding.write`).
- Périmètre : retenues opérées sur les factures d'achat enregistrées, payées dans le mois (date de paiement = dernier règlement du mois).
- Choix par facture du **code d'opération TEJ** (RS1_000001 … RS11_000001, taux du cahier des charges, `tej-codes.js`), de la convention de non double imposition (CNPC) et de la prise en charge. Stocké dans `withholding_tej_operations` (migration 020) : la facture enregistrée n'est jamais modifiée.
- Contrôles : taux de la facture = taux du code ; MontantRS = TTC × taux (arrondi au millime, sinon erreur — jamais recalculé en silence) ; TVA à taux unique (0/7/13/19 %) ; matricule fiscal, adresse, e-mail et téléphone du fournisseur ; seuil de 1 000 DT TTC pour RS7 ; paiement partiel (avertissement) ; référence de certificat unique ; facture en devise refusée.
- CSV de préparation en millimes. XML : racine, éléments et formats d'après l'exemple complet du §7.6 ; textes nettoyés (accents, `& ; * -- /* &#`, `'OR`/`'AND` interdits par le cahier des charges), nom de fichier `[MF]-[année]-[mois]-[acte].xml`, aucun commentaire.
- **Garde-fou : l'export XML est refusé (409 `TEJ_XSD_MISSING`) tant que les XSD officiels ne sont pas dans `server/schemas/tej/`, et (422 `TEJ_XSD_INVALID`) si le fichier généré ne passe pas la validation XSD** (xmllint-wasm, multiplateforme). Le XML n'est donc jamais présenté comme conforme sans validation ; l'acceptation finale reste celle de TEJ (test de contenu côté plateforme).
- **XSD officiels installés (nov. 2026)** dans `server/schemas/tej/` : `TEJDeclarationRS_v1.0.xsd`, `TEJRSCodesOperations_v1.0.xsd`, `TEJISOPaysDevises.xsd`. Le schéma de test reconstruit a été supprimé : les tests valident contre les vrais fichiers. Correction locale : la copie reçue de `TEJISOPaysDevises.xsd` contenait une balise `</xs:enumeration>` en trop (ligne 1580) et n'était pas du XML valide ; la ligne a été retirée, l'original est conservé (`.original-dgi`). Le validateur a aussi révélé que `TotalMontantTTC` (obligatoire dans `TotalPayement`) manquait dans le XML généré : ajouté.
- Dépôt : **manuel**. Après génération, l'écran affiche les étapes pour déposer le fichier sur tej.finances.gov.tn ; MHFac ne dépose rien et ne garantit pas l'acceptation.
- Incohérences du PDF constatées (nom de racine `DeclarationRS`/`DeclarationsRS`, `TypeIdentifiant` du passeport 3 ou 4, `InfoContact`/`InfosContact`, `NomPrenomOuRaisonSociale`/`NometprenonOuRaisonsociale`) : les XSD officiels tranchent : racine `DeclarationsRS`, `InfosContact`, `NometprenonOuRaisonsociale`, `DatePayement`, `TotalPayement` (noms confirmés), les noms sont centralisés dans `SCHEMA` (`tej-xml.js`).
- Non géré (à signaler à l'utilisateur) : bénéficiaire par CIN / passeport / carte de séjour / autre identifiant ; bloc Devise ; retenue sur TVA (`TaxeAdditionnelle`, RSTVA100/25) ; plusieurs opérations par certificat ; fichiers rectificatifs (modification/annulation de certificats, `ActeDepot` = 1) ; déclarant personne physique (catégorie PM par défaut) ; dépôt automatique sur TEJ.
- Tests : `tej_prep.test.js` (4 tests : contrôles, nettoyage de texte, flux complet validé contre les XSD officiels, codes d'opération présents dans le XSD).

## 9H — Soldes en temps réel : fournisseurs et clients

Pages **Achats › Soldes fournisseurs** (`/purchases/balances`, permission `purchase.read`) et **Ventes › Créances clients** (`/sales/balances`, permission `invoice.read`), même moteur (`modules/balances/balances.routes.js`) monté deux fois : `/supplier-balances` et `/client-balances`.

Règle de calcul (identique aux soldes de facture existants), recalculée à chaque appel, sans valeur stockée :
- Solde d'une facture = `net_payable − paid_amount − avoirs enregistrés`, plancher à 0 ; factures brouillon/annulées exclues. Pour un achat, `net_payable` est déjà net de la retenue à la source.
- Une ligne par tiers **et par devise** (jamais de mélange de devises).
- **Échu** = échéance antérieure à aujourd'hui (fuseau Africa/Tunis) ; ancienneté en tranches 1-30, 31-60, 61-90, +90 jours ; **non échu** = le reste.
- **Avances non affectées** = règlements enregistrés moins leurs affectations ; **solde net** = total dû − avances (peut être négatif : crédit en faveur du tiers).
- Routes : `GET /` (liste filtrable `q`, `currency`, `overdueOnly`, `minAmount`, tri, 15/page, totaux par devise dans `meta.totals`), `GET /export` (CSV), `GET /:id` (factures ouvertes + règlements non affectés), `GET /:id/statement` (relevé chronologique avec solde cumulé, `from`/`to`/`currency`) et `/statement/export`. Audit des exports ; tiers d'une autre entreprise → 404.
- Le solde final du relevé = solde net de la liste (les avances y sont incluses).

Limites : calcul à la volée en mémoire côté serveur (adapté à quelques milliers de tiers ; au-delà prévoir agrégation SQL paginée / index), relevé non limité en nombre de lignes (un tiers à la fois), pas de lettrage manuel ni de relance automatique (voir « Relances clients »), pas de conversion de devises, pas de graphique d'ancienneté. Tests : `tests/balances.test.js` (2 tests).

## 9I — FODEC (Fonds de Développement de la Compétitivité Industrielle)

**Règle appliquée** (à faire valider par votre comptable) : 1 % du HT sur les ventes locales de produits soumis (liste officielle, décret 2000-634). Le FODEC s'ajoute au HT **avant** la TVA : base de TVA = HT + FODEC. Exemple : HT 1000,000 → FODEC 10,000 → base TVA 1010,000 → TVA 19 % 191,900 → TTC 1201,900 (+ timbre 1,000 = 1202,900).

**Choix faits par défaut** (à confirmer ou modifier) :
- ventes uniquement (devis, commandes, factures, avoirs) ; les achats ne portent pas de FODEC ;
- **désactivé par défaut** : Paramètres de facturation → « Appliquer le FODEC sur les ventes » + taux (1,00 % modifiable) ;
- case **« Soumis au FODEC »** sur chaque article (produits uniquement, jamais les services) ; case « FODEC » modifiable ligne par ligne dans l'éditeur ;
- calcul 100 % serveur (`core/calc.js`), par taux de TVA, après remise globale ; un document émis n'est jamais recalculé silencieusement ; les avoirs reprennent le FODEC au prorata.

**Visible** : éditeur, vue document, PDF (ligne FODEC), rapport des ventes (colonne FODEC), rapport TVA (base incluant le FODEC), e-facture simulée (champ `fodecAmount`).

**Limites connues** : pas de FODEC sur les achats ni à l'importation (douane) ; sur les factures d'acompte, le FODEC n'est pas ventilé ; la liste des produits soumis relève de l'entreprise ; pas de déclaration mensuelle FODEC générée (le rapport des ventes donne le total) ; le compte 446800 « État – FODEC » est indicatif (pas de comptabilité générale dans MHFac).

**Tests** : `server/tests/fodec.test.js` (moteur, activation/articles/lignes, devis → commande → facture → avoir partiel).

## 9J — Retenue à la source ajoutée après l'émission (« Ajouter RS »)

**Besoin** : la retenue à la source a été oubliée à la création de la facture ; une facture émise ne doit pas être modifiée.

**Principe** : bouton **« Enregistrer une retenue à la source »** sur la facture émise (vente) ou enregistrée (achat). La facture n'est **jamais** touchée (total, net à payer, numéro inchangés). La retenue est un événement côté règlement :
- un règlement de mode `withholding` (numérotation REG/RGF habituelle) affecté à la facture : il **diminue le reste à payer**, est **annulable avec motif** (historique conservé), n'écrit rien en trésorerie ;
- une fiche `document_withholdings` (migration 022) : taux, base (TTC hors timbre), montant, date, n° de certificat facultatif ;
- audit : `payment.create`/`supplier_payment.create` + `withholding.add`.

**Calcul 100 % serveur** : montant = taux × TTC hors timbre, arrondi au millime ; aperçu (`dryRun`) fourni par le serveur à l'écran.

**Règles** (choix par défaut, à valider avec votre comptable) :
- ventes (retenue subie : le client retient) **et** achats (retenue que nous opérons : alimente la préparation TEJ) ;
- refus si la facture comporte déjà une retenue à la création, si une retenue ajoutée est déjà active, si la facture est brouillon/annulée, si la date est future ou antérieure à la facture, si le montant dépasse le **reste à payer** (annuler/corriger d'abord le règlement concerné : aucune requalification automatique de paiements déjà faits) ;
- n° de certificat facultatif (complété plus tard dans la page Retenues) ;
- le mode `withholding` n'est pas saisissable dans un règlement manuel et n'apparaît pas dans `/methods` ;
- exclue du rapport des encaissements, du tableau de bord (encaissé) et des notifications de règlement : ce n'est pas une entrée d'argent.

**Intégration** : pages Retenues (ventes/achats : badge « Ajoutée après émission », suivi du certificat), préparation TEJ (mois de la date de retenue, montant de la retenue ajoutée), solde et relevé du tiers.

**Limites** : traitement comptable de l'acompte d'impôt côté ventes à valider avec le comptable ; en cas d'avoir partiel, la base reste le TTC de la facture ; export XML TEJ toujours bloqué sans XSD officiels.

**Tests** : `server/tests/added_withholding.test.js` (vente, achat/TEJ, refus, droits/isolation, concurrence).

## 9K — Administration de la plateforme et page d'accueil publique

**Page d'accueil publique** (`client/src/pages/landing/`) — intégrée au projet (la maquette externe initiale devient inutile : tout vit désormais ici).
- Affichée à la racine `/` pour un visiteur **non connecté** ; un utilisateur connecté arrive directement sur son tableau de bord. Toute autre adresse protégée redirige vers `/login` comme avant.
- Les **offres et les prix viennent de l'API publique** `GET /api/v1/public/plans` (offres actives et publiques uniquement, aucune donnée d'entreprise, cache 5 min). Source unique : l'administration de la plateforme. Si l'API ne répond pas, un repli statique s'affiche (jamais une page vide).
- Les CTA mènent à l'**essai gratuit de 14 jours** (`/register`) ; WhatsApp reste proposé pour une démonstration.
- Captures d'écran (`client/public/landing/`) : prises sur l'application avec le jeu de **démonstration fictif** (`npm run seed-demo`), mentionné dans le texte alternatif. À remplacer par vos propres captures si vous le souhaitez (mêmes noms de fichiers).
- **Carrousel d'aperçu** (`Carousel.jsx`) : 4 captures (tableau de bord, facture détaillée, paiements, achats), flèches, pastilles, balayage tactile, clavier ← →, pause, défilement automatique mis en pause au survol et désactivé si le visiteur préfère réduire les animations.
- **En-tête responsive** : sur mobile, logo + « Essai gratuit » + bouton menu (☰) qui ouvre la liste des sections et « Se connecter » ; se ferme au clic ou avec Échap.
- **SEO** : titre et description optimisés, balise canonical, Open Graph / Twitter (image `og-image.jpg` 1200×630), données structurées JSON-LD (Organisation, application logicielle, FAQ), favicon, `robots.txt` (pages privées exclues) et `sitemap.xml` générés au build, images aux dimensions déclarées et chargées en différé. **À faire en production** : renseigner `VITE_SITE_URL` (voir docs/DEPLOIEMENT.md), sinon canonical/OG/sitemap restent relatifs.
- La section « vidéo de démonstration » a été retirée tant que la vidéo n'est pas prête.
- Styles isolés par le préfixe `lp-` (`client/src/index.css`) : aucun effet sur l'application. Police des titres : DM Serif Display (Google Fonts) ; hors ligne, une police à empattement du système la remplace.
- La page ne revendique aucune conformité TTN/TEJ : la facturation électronique y est décrite comme « mode simulation ».

**Administration de la plateforme (propriétaire)** — `/platform` (super administrateur uniquement, sans accès aux données métier) :
1. **Entreprises** : offre, statut réel (essai / actif / expiré / suspendu), échéance utile (fin d'essai ou fin de période), filtre par abonnement.
2. **Alerte e-mail** à chaque virement déclaré par un client (`PLATFORM_ALERT_EMAIL`, sinon e-mail de contact des coordonnées bancaires) ; un échec d'envoi ne bloque jamais le client ; carte « Virements à vérifier » et « Échéances proches ou dépassées » sur l'accueil.
3. **Valider / rejeter le paiement** : la validation active l'offre et fixe l'échéance (calculée côté serveur).
4. **Expiration automatique** : un abonnement échu ou un essai terminé passe en **lecture seule** (calculé à chaque requête) ; la suspension manuelle (motif obligatoire) reste journalisée.
- Migration `023_plan_prices.sql` : tarifs Auto-entrepreneur 31 TND/mois (310/an) et Business 129 TND/mois (1 290/an), alignés sur la page d'accueil ; Découverte reste « sur demande ». Un prix déjà fixé par l'administrateur n'est jamais écrasé. Auto-entrepreneur : 1 utilisateur.
- Tests : `platform_admin.test.js` (4), `security.test.js` (route publique des offres déclarée volontairement publique), `pricing_trial.test.js` (tarifs).

**Limites honnêtes** : pas de paiement en ligne (virement validé à la main) ; pas de tâche qui écrit un statut « impayé » en base (l'expiration est calculée à la lecture) ; pas de rappel automatique après l'échéance.

## 9L — Finition avant mise en ligne (décisions)
- **Facturation électronique : « bientôt disponible ».** L'entrée reste dans le menu ; au clic, la page indique « Ce module sera disponible bientôt ». Côté serveur, le drapeau `EINVOICE_MODULE` (défaut `off`) fait répondre **501** à toutes les routes `/e-invoicing` (après authentification) ; plus aucun panneau de transmission sur les factures. Le code de simulation est conservé, réactivable plus tard (`EINVOICE_MODULE=on` + une vraie intégration TTN). La landing page et ses plans ne la présentent plus que comme « bientôt ».
- **Français uniquement.** Suppression du sélecteur de langue, de la langue de l'entreprise (Paramètres), du choix de langue des PDF et du bouton « PDF عربي » ; l'API n'accepte plus que `fr` (`locale`, `pdfLanguage`) ; les montants en lettres arabes sont supprimés. Les anciens réglages « arabe » déjà enregistrés sont ignorés. Seule la police de repli Cairo est conservée pour qu'un nom saisi en arabe (client, article) reste lisible sur le PDF français.
- **Impression des bons de mouvement de stock** : bouton « Imprimer (PDF) » sur les bons d'entrée, de prélèvement/sortie et de transfert (`GET /stock/{entries|withdrawals|transfers}/:id/pdf`, droit `stock.read`). Contenu : identité et logo de l'entreprise, numéro, date, entrepôts, motif, lignes (désignation, référence, unité, quantité ; coût unitaire seulement s'il est saisi sur un bon d'entrée), notes, trois zones de signature adaptées au type de bon, filigrane BROUILLON / ANNULÉ. Pas encore imprimables : fiches d'inventaire et retours (à ajouter si besoin).
- Tests : 228 (dont impression des bons de stock et module désactivé).

## 9M — Modèles d'en-tête et de pied de page des documents (nov. 2026)

**Besoin** : proposer plusieurs modèles d'en-tête et de pied de page pour les documents imprimés, avec un choix personnalisé.

**Décisions**
- Mise en page du corps du document inchangée (tableau, totaux, mentions) ; seuls l'en-tête et le pied de page changent. Le code est isolé dans `server/src/modules/sales/pdf-frame.js` (aucun calcul, aucun montant).
- Réglages dans `company_settings.branding` (JSON, pas de migration : les anciennes entreprises reçoivent les valeurs par défaut « Classique ») : `headerStyle` (`classic`, `centered`, `band`, `minimal`, `custom`), `headerText` (600 car. max), `headerAlign`, `showLogo`, `footerStyle` (`classic`, `columns`, `minimal`, `custom`), `footerText` (400 car. max), `footerAlign`, `showPageNumber`. Validation zod côté serveur ; retours chariot et caractères de contrôle retirés ; permission `settings.write` requise pour modifier.
- Personnalisé : texte libre multi-lignes (en-tête : 5 lignes, pied : 3 lignes affichées au plus après retour à la ligne, pour ne jamais déborder). Texte vide = repli sur l'identité de l'entreprise. Le titre, le numéro, le filigrane d'état (brouillon, annulé) et la pagination restent gérés par MHFac (la pagination peut être masquée en personnalisé).
- Bandeau couleur : texte noir ou blanc choisi selon la luminosité de la couleur (lisible même avec une couleur claire).
- Aperçu en direct : `POST /sales/sample-pdf` accepte un objet `branding` (mêmes champs) qui surcharge les réglages pour l'aperçu, sans rien enregistrer.
- Un document est toujours imprimé avec le modèle **en vigueur à l'impression** (les PDF ne sont pas figés) ; le contenu comptable d'un document émis ne change jamais.

**Périmètre** : devis, commandes client, factures (tous types), avoirs, bons de livraison, bons de commande fournisseur (`renderDocumentPdf`). **Non concerné pour l'instant** : bons de mouvement de stock (`voucher-pdf.js`) et rapports PDF, qui gardent leur mise en page propre.

**Fichiers** : `server/src/modules/sales/pdf-frame.js` (nouveau), `pdf.js`, `preview.routes.js`, `companies/settings.js`, `tests/pdf_frame.test.js` (3 tests), `client/src/features/sales/LogoColorCard.jsx` (choix avec vignettes, champs personnalisés, aperçu).
Tests : 231.

## 9N — Numérotation des documents configurable (nov. 2026)

**Besoin** : l'utilisateur choisit librement, pour chaque type de document, l'abréviation (FAC, F, BC, BL…) et le format du numéro.

**Décisions**
- **20 types configurables** (registre `DOC_TYPES` dans `core/numbering.js`) : ventes (devis, bon de commande client, facture, avoir, bon de livraison, retour client, règlement, note de débours), achats (bon de commande fournisseur, réception, facture d'achat, avoir fournisseur, retour fournisseur, règlement, note de débours), stock et trésorerie (entrée, prélèvement, transfert, inventaire, opération de trésorerie). Les codes clients, fournisseurs, articles et projets gardent leurs codes propres (ce ne sont pas des documents).
- **Réglages par type** : abréviation (1 à 10 lettres ou chiffres, mise en majuscules), séparateur (`-`, `/`, `.`, `_` ou aucun), année dans le numéro (oui/non), remise à zéro chaque année (oui/non), nombre de chiffres (3 à 8), prochain numéro. Défaut = format historique `FAC-2026-00001`, donc aucune entreprise existante n'est modifiée. Stockage : `company_settings.numbering` (pas de migration).
- **Garanties anti-doublon** : (1) un numéro déjà attribué n'est jamais modifié, le réglage ne vaut que pour les documents suivants ; (2) le compteur ne peut qu'augmenter (`COUNTER_LOWER` sinon) ; (3) une abréviation appartient à un seul type de document de l'entreprise (`PREFIX_DUPLICATE`, insensible à la casse) ; (4) avec remise à zéro annuelle l'année est obligatoire dans le numéro (sinon deux années auraient le même numéro) ; (5) en passant de « remise à zéro annuelle » à « numérotation continue » (ou l'inverse), le nouveau compteur repart au plus haut numéro déjà utilisé ; (6) l'attribution reste atomique et sans trou (`nextNumber` dans la transaction de création/émission/validation).
- **API** : `GET /companies/current/numbering` (permission `settings.read`), `PUT /companies/current/numbering` (permission `settings.write`, audit `company.numbering_updated`). Le PATCH général des réglages ne peut pas modifier la numérotation (validation contournable sinon).
- **Moment de l'attribution inchangé** : devis et commandes à la création, factures/avoirs à l'émission, bons à la validation. L'année vient de la date du document, comme avant.
- Noms de fichiers PDF : le numéro peut contenir `/` (ex. `F/2026/001`) ; le nom de fichier téléchargé est assaini (`utils/filename.js`).
- **Limites** : un autre logiciel déjà utilisé avec des numéros plus élevés se gère avec « Prochain n° ». Aucune conformité officielle n'est affirmée : la loi tunisienne impose une numérotation continue et chronologique des factures, à valider avec votre comptable (voir 9L/9M pour les avertissements).

**Fichiers** : `server/src/core/numbering.js` (registre, format, `nextDocNumber`), `server/src/modules/companies/numbering.routes.js`, 16 appels remplacés (ventes, achats, paiements, trésorerie, stock, débours), `client/src/features/sales/NumberingCard.jsx` (Paramètres), `tests/numbering_config.test.js` (6 tests). Tests : 237.

## 9O — Modèles d'en-tête et de pied de page sur les bons de stock

Les bons d'entrée, de prélèvement et de transfert utilisent désormais le même cadre que les documents commerciaux (`sales/pdf-frame.js`) : le modèle choisi dans Paramètres s'applique, y compris le modèle personnalisé. La date du bon passe dans le bloc d'informations. Filigrane BROUILLON/ANNULÉ et zones de signature inchangés. **Non appliqué volontairement aux rapports PDF** (paysage, tableaux larges, mention légale obligatoire en pied de page) : ce sont des documents de gestion internes, pas des documents remis à un client. Tests : 238.

## 9P — Correctif : solde négatif sur facture d'achat

Symptôme : la liste « Factures d'achat » affichait « Montant invalide : -2391.186 » (erreur 500). Cause : quand avoirs + règlements dépassent le net à payer (cas normal avec retenue à la source ou timbre, car le plafond d'avoir se calcule sur le TTC), `subMoney` produisait un nombre négatif que `cmpMoney` refusait. Correctif : `addMoney`, `subMoney` et `cmpMoney` acceptent un signe « - » (le solde affiché reste borné à 0,000) ; `toScaled`, qui valide les saisies, reste strict. Test ajouté dans `calc.test.js`. Tests : 239.

## 9Q — Compatibilité TiDB Cloud : migrations

TiDB refuse d'ajouter une colonne et une clé étrangère sur cette colonne dans une même commande `ALTER TABLE` (erreur « Key column … doesn't exist in table » sur la migration 005). 19 commandes `ALTER TABLE` à plusieurs clauses (migrations 005, 006, 009, 011, 014, 019, 021) ont été séparées en commandes à une clause : résultat identique sous MySQL/MariaDB. Vérifié : 23 migrations appliquées sur une base vierge MariaDB, 239 tests OK. **Non vérifié sur TiDB lui-même** depuis cet environnement : tester `npm run migrate` sur une base TiDB vide. Les DDL n'étant pas transactionnels, une migration en échec laisse des tables créées : repartir d'une base vide (`DROP DATABASE mhfac;`).

## 9R — Offre choisie à l'inscription et aperçu de lien

- **Choix de l'offre** : la page d'inscription affiche les offres vendues en libre-service (lues dans `GET /public/plans`, donc identiques à la page d'accueil et à l'administration) ; l'offre peut être présélectionnée par `/register?plan=<code>` (boutons des cartes de la page d'accueil). `POST /auth/register-company` accepte `planCode` : l'essai de 14 jours démarre **sur l'offre choisie** (limites et fonctions de cette offre dès le premier jour), sans choix c'est `DEFAULT_PLAN_CODE`. Refus 400 `INVALID_PLAN` (inconnue, inactive ou non publique) et `PLAN_ON_REQUEST` (offre sans prix, par ex. Découverte : contact par WhatsApp). L'offre est tracée dans le journal d'audit (`company.registered`, meta.plan). Le super administrateur la voit dans la liste des entreprises ; l'utilisateur la voit en pastille dans l'en-tête (« Pro · essai 12 j », lien vers Abonnement).
- **Aperçu Messenger/WhatsApp/Facebook affichant « / »** : cause = `VITE_SITE_URL` vide, donc `og:url` et `og:image` relatifs. Le build utilise maintenant `VITE_SITE_URL`, sinon l'adresse de production fournie par Vercel (`VERCEL_PROJECT_PRODUCTION_URL`). Les réseaux sociaux gardent l'ancien aperçu en cache : le rafraîchir via l'outil de débogage de partage de Facebook. Tests : 240.

## 9S — Correctif TiDB : « Erreur interne » sur la préparation TEJ (ONLY_FULL_GROUP_BY)

La page « RS Achats / Autres » affichait « Erreur interne » en ligne (TiDB), pas en local (MariaDB). Cause : MySQL 8 et TiDB activent `ONLY_FULL_GROUP_BY`, qui refuse les requêtes `GROUP BY d.id` lisant des colonnes jointes non agrégées (fournisseur, opération TEJ, certificat), alors que MariaDB l'accepte. Une trentaine de requêtes utilisent `GROUP BY` : plutôt que d'en réécrire à l'aveugle sans pouvoir les tester sur TiDB, chaque connexion retire ce seul drapeau de `sql_mode` (`config/db.js`), ce qui aligne le comportement en ligne sur celui testé (240 tests). Vérifié : avec `ONLY_FULL_GROUP_BY` actif au niveau serveur, la session du pool ne l'a plus. Limite : ces requêtes lisent des colonnes en relation 1-1 avec la ligne groupée, donc le résultat est déterministe ; toute future requête `GROUP BY` doit rester dans ce cas ou agréger explicitement.

## 9T — Matricule fiscal complet accepté (TEJ)

Le contrôle de préparation TEJ refusait un matricule fiscal tunisien complet (`1654872X/A/M/000` : 7 chiffres + clé, code TVA, catégorie, établissement) car il collait toutes les parties (`1654872XAM000`). Le XSD officiel (`Identifiant` = `\d{7}[A-Z]`) n'attend que `1654872X` : `normalizeMf` extrait désormais ces 8 caractères des formes complètes (séparateurs `/`, `.`, `-`, espaces ; suffixes lettre-lettre-3 chiffres) et s'applique au déclarant, au bénéficiaire et au nom de fichier. Les formes invalides (CIN, 8 chiffres, suffixe incomplet) restent refusées. Test ajouté. Tests : 241.


## 9U — Matricule du véhicule et alerte « stock insuffisant » par ligne

**Matricule du véhicule** (migration `024_vehicle_plate.sql`, une colonne `vehicle_plate VARCHAR(20)` par table) sur le bon de livraison, le bon de réception et le **bon de transfert** (pas sur les bons d'entrée/prélèvement : la valeur y est ignorée côté serveur). Texte libre (formats tunisiens variés, ex. « 123 TUN 4567 »), normalisé par `utils/plate.js` : espaces réduits, majuscules, caractères de contrôle retirés, 20 caractères max, vide = non renseigné. Modifiable **tant que le bon est en brouillon** ; un bon validé reste verrouillé (règle inchangée). Affiché sur le PDF du bon de livraison et du bon de transfert, dans les formulaires et les fiches. Les bons générés depuis une facture n'ont pas de matricule (champ vide). Le bon de réception n'a pas de PDF (limite connue).

**Alerte stock insuffisant** : dans l'éditeur de devis, commande et facture, un message orange apparaît **sous la ligne** concernée (« Stock insuffisant : X disponible(s) pour Y demandé(s) ») dès qu'un article suivi en stock dépasse le disponible. Nouvelle route lecture seule `POST /stock/availability` (permission `stock.read`, mêmes calculs que le contrôle existant, aucune écriture). Si la facture coche « sortir du stock » et que le réglage interdit le stock négatif, le message passe en rouge (« l'émission sera refusée ») ; sinon il reste un avertissement : le stock négatif étant autorisé par défaut, rien n'est bloqué. Les quantités d'un même article sur plusieurs lignes sont cumulées. Entrepôt contrôlé : celui choisi sur la facture, sinon l'entrepôt par défaut.

Déploiement : `npm run migrate` (Render l'exécute au démarrage via `migrate:cloud`). Tests : `tests/vehicle_plate.test.js` (4) ; `security.test.js` exclut `/availability` (calcul sans écriture).

**Décision (9U bis) : une facture n'est jamais refusée pour stock insuffisant.** À l'émission d'une facture avec « sortir du stock », le stock peut devenir négatif même si le réglage « stock négatif autorisé » est désactivé (`issueStockExit` force `allowNegative: true`). Le message de ligne reste un avertissement orange, jamais bloquant. Les bons de livraison et bons de prélèvement gardent le réglage de l'entreprise.
