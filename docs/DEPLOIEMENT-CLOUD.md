# MHFac — Test en ligne avec Vercel + Render + Aiven

Architecture : le navigateur parle **uniquement à Vercel** (même domaine). Vercel sert le site et **relaie `/api/*` vers Render** (`client/vercel.json`). Cela garde le cookie de session `SameSite=Strict` valable. Render exécute l'API, Aiven héberge MySQL.

## 0. Limites à connaître
- Render **gratuit** : mise en veille après ~15 min (premier appel lent), 512 Mo de mémoire (la lecture des scans peut échouer), tâches planifiées (factures récurrentes, rappels) arrêtées pendant la veille. Pour un test sérieux : offre Starter (~7 $/mois).
- Aiven MySQL gratuit : une seule base, ressources limitées, conditions d'inactivité à vérifier sur leur site ; ne convient pas à de vraies données clients.
- Régions : choisissez Render et Aiven dans la **même région** (ex. Francfort) pour la latence.
- Vercel relaie les requêtes : durée maximale limitée, pas de gros envois ; les PDF et pages courantes passent sans problème.
- `npm run backup` (mysqldump) n'est pas prévu pour ce montage : utilisez les sauvegardes d'Aiven.

## 1. Aiven (base MySQL)
1. Créer un service **MySQL** (plan Free si proposé), région Europe.
2. Onglet *Overview* : noter Host, Port, User (`avnadmin`), Password, base `defaultdb`.
3. Télécharger le **CA certificate**. Ouvrez-le : pour `DB_SSL_CA`, collez le texte en remplaçant chaque retour à la ligne par `\n` (une seule ligne). Facultatif : sans `DB_SSL_CA`, les autorités du système sont utilisées.

## 2. Render (API)
1. *New → Blueprint* → choisir le dépôt GitHub `mhfac` (`render.yaml` à la racine) ; ou *New → Web Service* avec : Root Directory `server`, Build `npm ci --omit=dev`, Start `npm run migrate:cloud && npm run start:cloud`.
2. Saisir les variables : `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME=defaultdb`, `DB_SSL=true`, `DB_SSL_CA`, `TRUST_PROXY=2`, `NODE_ENV=production`, `CLIENT_URL=https://<votre-site>.vercel.app`, secrets JWT (générés par Render).
3. Les migrations s'appliquent à chaque démarrage (sans effet si déjà faites).
4. Tester : `https://<votre-api>.onrender.com/api/v1/health` → `status: ok`, `db: up`.
5. Créer le super administrateur : onglet *Shell* de Render, `npm run create-admin:cloud -- --email ... --name ...` (voir ci-dessous) ou, en local, avec le `.env` pointant temporairement vers Aiven.

## 3. Vercel (site)
1. *Add New → Project* → dépôt `mhfac`, **Root Directory : `client`**, framework Vite.
2. Ne définir **aucune** variable `VITE_API_URL`.
3. Dans `client/vercel.json`, remplacer `REMPLACER-PAR-VOTRE-API.onrender.com` par l'adresse réelle de l'API, puis valider/pousser sur GitHub.
4. Après déploiement, mettre l'URL Vercel dans `CLIENT_URL` côté Render.

## 4. Vérifications
- Ouvrir le site Vercel, créer une entreprise, se déconnecter / reconnecter (test du cookie).
- Télécharger un PDF de facture.
- Si la connexion boucle : vérifier `CLIENT_URL`, `TRUST_PROXY=2` et que l'appel `/api/v1/...` passe bien par le domaine Vercel (onglet Réseau).

## 5. Sécurité
- Aucun secret dans Git : tout est dans les tableaux de bord Render/Aiven/Vercel.
- Les secrets JWT de test ne sont jamais ceux d'un autre environnement.
- E-mails : `MAIL_PROVIDER=smtp` + `SMTP_*` pour des envois réels ; sinon ils s'affichent dans les journaux Render.
