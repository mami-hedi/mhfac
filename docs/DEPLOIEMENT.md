# MHFac — Installation, exploitation, sauvegarde

Ce document couvre : installation Windows, lancement en développement, mise en production, sauvegarde/restauration, et les limites de la facturation électronique. Aucun chemin local n'est codé en dur : tout passe par des variables d'environnement.

## 1. Prérequis

| Élément | Version | Remarque |
| --- | --- | --- |
| Node.js | 20 LTS ou plus | https://nodejs.org (cocher « Add to PATH ») |
| MySQL | 8.0 (ou MariaDB 10.6+) | `mysqldump` et `mysql` doivent être dans le PATH pour la sauvegarde |
| Mémoire | 1 Go libre conseillé | la lecture OCR des scans est gourmande (quelques secondes par page) |

Aucun service payant ni clé API n'est nécessaire : le scan de factures fournisseur est **local et gratuit**.

## 2. Installation sous Windows (développement ou petite exploitation)

1. Installer Node.js 20+ et MySQL 8 (MySQL Installer, option « Server only »). Noter le mot de passe `root`.
2. Créer la base et l'utilisateur (invite « MySQL Command Line Client », en `root`) :
   ```sql
   CREATE USER 'mhfac'@'localhost' IDENTIFIED BY 'UnMotDePasseSolide!';
   GRANT ALL PRIVILEGES ON mhfac.* TO 'mhfac'@'localhost';
   GRANT ALL PRIVILEGES ON mhfac_test.* TO 'mhfac'@'localhost';
   ```
   (`mhfac_test` n'est utile que pour lancer les tests.) `npm run migrate` crée la base si besoin.
3. Dans PowerShell, dossier du projet (ex. `D:\Projects\mhfac`) :
   ```powershell
   cd server
   npm install
   copy .env.example .env
   notepad .env
   ```
   Renseigner dans `.env` : `DB_USER`, `DB_PASSWORD`, et deux secrets **différents** de 32 caractères minimum :
   ```powershell
   node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
   ```
   (à lancer deux fois : un résultat pour `JWT_ACCESS_SECRET`, l'autre pour `JWT_REFRESH_SECRET`).
4. Appliquer le schéma : `npm run migrate` (puis `npm run migrate:status` pour vérifier : toutes les migrations « appliquées »).
5. Créer le **super administrateur** de la plateforme (gère les offres et abonnements ; n'a aucun accès aux données des entreprises) :
   ```powershell
   npm run create-admin -- --email vous@exemple.tn --name "Votre Nom"
   ```
   Le mot de passe est demandé de façon masquée (12 caractères min., majuscule, minuscule, chiffre) — ou variable `PLATFORM_ADMIN_PASSWORD`.
6. Lancer l'API : `npm run dev` → http://localhost:4000/api/v1/health doit répondre `{"data":{"status":"ok","db":"up",...}}`.
7. Autre terminal, le client :
   ```powershell
   cd client
   npm install
   copy .env.example .env
   npm run dev
   ```
   Ouvrir http://localhost:5173 → « Créer mon entreprise ».
8. (Optionnel) Données de démonstration **fictives** : API démarrée, puis `npm run seed-demo` dans `server`. Le script affiche l'e-mail et le mot de passe générés. Il refuse de tourner si `NODE_ENV=production`.

### Commandes utiles (dossier `server`)

| Commande | Effet |
| --- | --- |
| `npm run dev` / `npm start` | API avec rechargement / API normale |
| `npm run migrate`, `migrate:status` | Applique / liste les migrations |
| `npm test` | 239 tests automatisés (base `mhfac_test`, voir `.env.test.example`) |
| `npm run create-admin` | Crée ou promeut le super administrateur |
| `npm run seed-demo` | Charge une entreprise de démonstration fictive |
| `npm run docs:api` | Régénère `docs/API.md` depuis les routes réelles |
| `npm run backup` / `restore` | Sauvegarde / restauration (voir §5) |

### Lancer les tests

```powershell
copy .env.test.example .env.test      # puis adapter DB_USER / DB_PASSWORD
node --env-file=.env.test scripts/migrate.js
npm test
```

## 3. Variables d'environnement

Toutes sont documentées ligne à ligne dans `server/.env.example`. Points d'attention en production :

| Variable | Production |
| --- | --- |
| `NODE_ENV` | `production` (cookie de session `Secure`, erreurs internes masquées) |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` | Aléatoires, ≥ 32 caractères, distincts, jamais versionnés |
| `CLIENT_URL` | URL publique exacte du site (liste blanche CORS), ex. `https://facture.exemple.tn` |
| `DB_*` | Utilisateur MySQL dédié, droits limités à la base `mhfac` |
| `MAIL_PROVIDER` / `SMTP_*` | `smtp` avec vos identifiants : **obligatoire** pour que les e-mails (invitations, rappel de fin d'essai, confirmation de paiement) partent réellement ; `console` = affichage dans les journaux seulement |
| `EINVOICE_PROVIDER` | Laisser `simulation` (voir §6) |
| `EINVOICE_MODULE` | `off` (défaut) : facturation électronique « bientôt disponible », toutes ses routes répondent 501 |
| `DEFAULT_PLAN_CODE` | Offre attribuée aux nouvelles entreprises (par défaut `pro`) |
| `TRIAL_REMINDER_DAY` | Jour de l'essai où part l'e-mail de rappel « fin d'essai + paiement » (défaut 12) |
| `TRIAL_DAYS` | Jours d'essai gratuit à l'inscription (défaut 14 ; 0 = aucun) |
| `VITE_SITE_URL` (client, Vercel) | Adresse publique du site sans « / » final, ex. `https://facture.exemple.tn` : active canonical, Open Graph, `sitemap.xml` et `robots.txt` complets |
| `PLATFORM_ALERT_EMAIL` | Votre e-mail : alerté à chaque virement déclaré par un client (vide = e-mail de contact des coordonnées bancaires) |
| `API_RATE_LIMIT_PER_MIN`, `AUTH_RATE_LIMIT_MAX`, `LOGIN_*` | Limites anti-abus ; ajuster selon le trafic |
| `SCAN_MAX_MB`, `SCAN_HOURLY_LIMIT` | Taille et fréquence des scans |

## 4. Mise en production

Architecture recommandée : **un serveur** avec reverse proxy HTTPS, l'API Node en service, MySQL local ou managé.

1. **Serveur** (Linux conseillé ; Windows Server possible) : installer Node 20+, MySQL 8, un reverse proxy (Nginx ou Caddy).
2. **Code** : copier le projet, puis `cd server && npm ci --omit=dev`. Créer `.env` (voir §3).
3. **Schéma** : `npm run migrate`, puis `npm run create-admin -- --email ... --name ...`.
4. **Client** : `cd client && npm ci && npm run build` → dossier `client/dist` (fichiers statiques). Laisser `VITE_API_URL` **vide** : le client appelle `/api` sur le même domaine.
5. **API en service** :
   - Linux (systemd) : unité exécutant `node --env-file=/chemin/.env src/server.js` dans `server/`, `Restart=always`, utilisateur non privilégié.
   - Windows : `npm install -g pm2`, `pm2 start src/server.js --name mhfac-api` dans `server\` (avec les variables d'environnement définies au niveau du service), `pm2 save` ; ou NSSM pour un vrai service Windows.
6. **Reverse proxy** : servir `client/dist` à la racine (avec repli sur `index.html` pour les routes React) et relayer `/api/` vers `http://127.0.0.1:4000`. Exemple Caddy :
   ```
   facture.exemple.tn {
     handle /api/* { reverse_proxy 127.0.0.1:4000 }
     handle { root * /var/www/mhfac/client/dist
              try_files {path} /index.html
              file_server }
   }
   ```
   **HTTPS est obligatoire** : le cookie de rafraîchissement est `Secure` en production. L'API fait confiance à un proxy (`trust proxy` = 1) pour l'adresse IP réelle (limitation de débit) : ne l'exposez pas directement sans proxy.
7. **Pare-feu** : n'ouvrir que 80/443. Le port 4000 et le port MySQL (3306) restent fermés à l'extérieur.
8. **Avant d'ouvrir aux clients** : connectez-vous avec le super administrateur → *Plateforme → Paiements* → saisissez et publiez vos vraies coordonnées bancaires (tant que ce n'est pas fait, les clients ne peuvent pas payer). Réglez `CLIENT_URL` et SMTP (voir §3).
9. **Vérification** : `https://votre-domaine/api/v1/health` → `status: ok`, `db: up`.
10. **Mises à jour** : sauvegarde (§5) → nouveau code → `npm ci` → `npm run migrate` → redémarrage de l'API → reconstruction du client. Les migrations sont versionnées et ne sont jamais rejouées.

Ne chargez **jamais** `seed-demo` en production.

## 5. Sauvegarde et restauration

Toutes les données (y compris les documents scannés, conservés dans la base comme pièces justificatives) sont dans MySQL : **sauvegarder la base suffit**. Conservez aussi votre fichier `.env` (secrets) en lieu sûr, séparément.

### Sauvegarder

```powershell
cd server
npm run backup
```
Produit `server/backups/<base>_AAAAMMJJ_HHMMSS.sql.gz` (dump cohérent, sans verrouiller l'application). Variables : `BACKUP_DIR` (dossier), `BACKUP_RETENTION_DAYS` (défaut 14 : purge automatique des plus anciennes), `MYSQLDUMP_PATH` si `mysqldump` n'est pas dans le PATH (ex. `C:\Program Files\MySQL\MySQL Server 8.0\bin\mysqldump.exe`). Le script échoue bruyamment (code ≠ 0, aucun fichier vide conservé) en cas de problème.

**Planification recommandée** : une sauvegarde quotidienne la nuit, copie hors serveur (autre machine ou stockage distant), et un test de restauration au moins une fois par trimestre.
- Windows : Planificateur de tâches → action « Démarrer un programme » : `cmd /c "cd /d D:\Projects\mhfac\server && npm run backup"`.
- Linux : `0 2 * * * cd /opt/mhfac/server && npm run backup >> /var/log/mhfac-backup.log 2>&1`.

### Restaurer

1. **Arrêter l'API.**
2. (Conseillé) faire d'abord une sauvegarde de l'état actuel.
3. `npm run restore -- backups/mhfac_20261101_020000.sql.gz --yes`
   Sans `--yes` le script refuse (opération destructive). Le client `mysql` doit être dans le PATH (ou `MYSQL_PATH`).
4. `npm run migrate:status` puis redémarrer l'API et contrôler `/api/v1/health`.

Pour tester sans risque : restaurer dans une base jetable (`DB_NAME=mhfac_verif npm run restore -- <fichier> --yes` après `CREATE DATABASE mhfac_verif`). Un aller-retour sauvegarde → restauration a été vérifié pendant la Phase 9 (mêmes nombres de lignes).

## 6. Facturation électronique : limites et prérequis

**MHFac n'est ni homologué, ni conforme, ni connecté à TTN (Tunisie TradeNet) ni à aucune plateforme officielle.** Le module fonctionne en **simulation**, clairement étiquetée dans l'interface et les documents : il prépare un fichier et un cachet *fictifs* et simule la transmission, pour valider le flux (états, reprises, idempotence, blocage de l'annulation d'une facture « transmise »).

Pour passer à une transmission réelle, il faudra (hors périmètre actuel, rien n'est promis) :
1. Obtenir les **spécifications officielles** en vigueur (format de fichier, schéma, API de la plateforme) auprès de l'organisme compétent.
2. Obtenir les **accès officiels** (compte opérateur, identifiants, environnement de test/homologation) et, selon les exigences, un **certificat de signature électronique** qualifié.
3. Écrire l'adaptateur réel (le point d'extension existe : `TtnProvider`, qui refuse volontairement de fonctionner aujourd'hui) et le faire **homologuer**.
4. Valider avec un professionnel (expert-comptable / conseil fiscal) les obligations applicables à votre activité.

Autres limites à connaître : les rapports sont des **états de gestion**, pas des états comptables ni des déclarations fiscales certifiées ; il n'y a **aucun paiement en ligne** (le changement d'offre se fait par l'administrateur de la plateforme) ; la lecture des scans est une **suggestion à relire**, la précision dépend de la qualité du document.
