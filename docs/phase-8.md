# Phase 8 — Rapports, tableau de bord réel, facturation électronique (SIMULATION)

## 8A — Rapports et tableau de bord
- 11 rapports de gestion (`GET /api/v1/reports`, `/reports/:key?format=json|csv|xlsx|pdf`) : ventes, encaissements, créances et dettes âgées, TVA, retenues, dépenses, stock, trésorerie, etc.
- Montants en devise de l'entreprise (montant × taux du document, arrondi 3 décimales) ; avoirs en négatif ; uniquement documents émis / enregistrés / validés.
- Exports CSV (UTF-8 BOM, `;`, virgule décimale, neutralisation des formules), Excel (exceljs), PDF. Plafond 20 000 lignes (422 `TOO_MANY_ROWS`). Chaque export est journalisé.
- Permissions : `report.read` + lecture du module source. Tableau de bord : KPIs et graphiques calculés côté serveur (aucune donnée statique), filtrés par permissions.
- **Limite** : ce sont des états de GESTION, pas des états comptables ni fiscaux certifiés (la TVA affichée n'est pas une déclaration).

## 8B — Facturation électronique : couche prête, fournisseur = SIMULATION
> **MHFac n'est ni homologué, ni conforme, ni connecté à TTN (Tunisie TradeNet) ni à aucune plateforme officielle.** Aucun format fiscal officiel, aucune API officielle n'ont été inventés. Tout est affiché « SIMULATION — non homologué TTN ».

Architecture (`server/src/modules/einvoice/`) :
- `InvoiceFormatAdapter` → `SimulationFormatAdapter` : format JSON INTERNE (`MHFAC-SIMULATION-JSON/1`), sans valeur fiscale.
- `ElectronicSignatureAdapter` → `SimulatedSignatureAdapter` : simple empreinte SHA-256 marquée `simulated` (pas une signature électronique).
- `TransmissionProvider` → `SimulationProvider` (scénarios `accept` / `reject` / `network_error`) et `TtnProvider` (emplacement réservé : refuse systématiquement, « non implémenté »).
- `einvoice.service.js` : machine d'états validée (`preparing → pending → transmitted/accepted/rejected/retry/error`), journal `einvoice_events`, clé d'idempotence (hash du contenu) → une seule transmission par facture, même référence à chaque renvoi, nouvelles tentatives avec délai croissant (1, 5, 15, 60, 240 min, 5 essais puis `error`), délai d'attente configurable (`EINVOICE_TIMEOUT_MS`, défaut 10000).
- Une facture dont la transmission est « Transmise » ou « Acceptée » ne peut plus être annulée (409 `EINVOICE_TRANSMITTED`) : on émet un avoir.
- API `/api/v1/e-invoicing` : `GET/PUT /config`, `GET /transmissions`, `GET /transmissions/:id`, `GET /invoices/:id`, `POST /invoices/:id/prepare`, `POST /transmissions/:id/submit|retry|refresh`, `POST /retry-due`. Permissions `einvoice.read/write/validate`.
- Interface : menu « Facturation électronique », encart sur la fiche facture émise, détail avec historique.

### Prérequis avant toute vraie intégration TTN
Spécifications techniques officielles, format de facture imposé, certificat de signature électronique, identifiants/accès au service, environnement de test officiel, homologation, et revue par un expert fiscal. Rien de cela n'est présent ici.

## 8C — Scan d'une facture fournisseur (lecture automatique, 100 % GRATUITE et LOCALE)
Parcours : **Achats → Scanner une facture** → téléverser un PDF/photo → lecture automatique → écran de relecture (document à gauche, champs à droite) → « Créer le brouillon » → brouillon de facture d'achat à corriger puis enregistrer.
- **Aucun coût, aucune clé API, aucun service externe** : le document ne quitte jamais le serveur.
- Moteur (`server/src/modules/purchase-scan/`) : `ocr.js` — PDF numérique : texte lu directement avec pdf.js (le plus fiable) ; photo, scan ou PDF scanné : OCR Tesseract (tesseract.js, langue française embarquée dans le paquet npm, fonctionne hors ligne, rien à installer sur Windows en dehors de `npm install`). `parse.js` — analyse par règles : fournisseur, matricule fiscal, n° de facture, dates, lignes (désignation, quantité, prix HT, TVA), totaux (HT, TVA, timbre, TTC, retenue). Interface `DocumentExtractor` remplaçable.
- **Rien n'est comptabilisé automatiquement** : la lecture est une suggestion ; l'utilisateur relit, puis le brouillon passe par le moteur de calcul serveur habituel (les montants envoyés ne sont pas lus). Les totaux imprimés sur le document sont comparés aux totaux recalculés ; tout écart est signalé.
- Sécurité : type du fichier déduit du contenu (PDF/PNG/JPEG/WebP), taille limitée (`SCAN_MAX_MB`, 8 Mo), limite horaire (`SCAN_HOURLY_LIMIT`, 30/h/entreprise), doublon de fichier refusé (SHA-256), fichier original conservé comme pièce justificative (téléchargement protégé par permission, `nosniff`), journal d'audit, isolation par entreprise, aucun code du document n'est exécuté.
- Rapprochement fournisseur : par matricule fiscal, sinon nom identique ; sinon bouton « Créer le fournisseur » (jamais de création automatique).
- **Limites honnêtes** : mises en page très inhabituelles, tableaux sans en-tête, photos floues/inclinées, manuscrit ou tampons sur les montants peuvent donner des lignes ou des chiffres faux ou manquants — d'où la relecture obligatoire. Pour de meilleurs résultats : PDF numérique ou photo nette et bien cadrée. Seules les 3 premières pages sont lues. Les avoirs fournisseur ne sont pas créés par ce parcours (422). Une première lecture OCR prend quelques secondes (chargement du moteur). Testé sur des factures générées pour les tests : à valider avec vos vraies factures.
- API : `POST /purchase-scans?filename=` (corps = fichier brut), `GET /purchase-scans[/:id[/file]]`, `POST /purchase-scans/:id/draft`, `DELETE /purchase-scans/:id`. Migration 013. Nouvelles dépendances : tesseract.js, @tesseract.js-data/fra, pdfjs-dist, @napi-rs/canvas.

## 8D — Entrée en stock directe depuis une facture d'achat
Case « Entrer les articles en stock à l'enregistrement » sur la facture d'achat (brouillon), avec choix d'entrepôt (défaut : entrepôt par défaut).
- À l'enregistrement, les lignes dont l'article est « suivi en stock » entrent en stock au coût de la facture (remise globale et change inclus, comme pour une réception). Les lignes sans article ou non suivies sont ignorées ; si aucune ligne n'est suivie : 422 `NOTHING_TO_STOCK`.
- **Interdit** (422 `STOCK_ENTRY_NOT_ALLOWED`) sur une facture créée depuis une commande ou une réception : le stock y entre par le bon de réception (évite le double comptage). Exige le droit de valider une réception.
- Annulation de la facture : mouvement inverse (le journal de stock n'est jamais modifié) ; refusée (409 `STOCK_INSUFFICIENT`) si le stock a déjà été sorti et que le stock négatif est interdit dans les réglages.
- Limites : les avoirs fournisseur et les retours fournisseur n'ajustent pas le stock d'une facture saisie ainsi (utiliser un bon de sortie manuel) ; l'option ne peut plus être modifiée après enregistrement. Migration 014 ; tests `purchase_stock_entry.test.js` ; e2e `docs/e2e/phase8d_stock_entry_test.py`.

## Lancer / tester
- `cd server && npm install` (nouvelle dépendance : exceljs) puis `npm run migrate` (migrations 012, 013 et 014) ; `npm test`.
- API + client puis `python3 docs/e2e/phase8_browser_test.py` (7 vérifications) ; pour 8C : `python3 docs/e2e/phase8c_browser_test.py` (lecture réelle d'une facture de test).
- Variable optionnelle : `EINVOICE_TIMEOUT_MS`.

## Cas limites couverts
Brouillon non préparable (422 `NOT_ISSUED`), double préparation, double soumission (409), isolation inter-entreprises (404), rôles lecture seule (403), rejet, erreur réseau puis reprise, annulation interdite après transmission.

## Reste (Phase 9)
Plans d'abonnement SaaS, permissions avancées, tests de sécurité, optimisation, déploiement, sauvegarde/restauration, documentation finale. Planification automatique de `retry-due` : à brancher sur un cron (non inclus).
