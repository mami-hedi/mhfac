# MHFac — Test en ligne avec Vercel + Render + TiDB Cloud

Architecture : le navigateur parle **uniquement à Vercel** (même domaine). Vercel sert le site et **relaie `/api/*` vers Render** (`client/vercel.json`). Cela garde le cookie de session `SameSite=Strict` valable. Render exécute l'API, TiDB Cloud héberge la base MySQL.

## 0. Limites à connaître
- Render **gratuit** : mise en veille après ~15 min (premier appel lent), 512 Mo de mémoire (la lecture des scans peut échouer), tâches planifiées (factures récurrentes, rappels) arrêtées pendant la veille. Pour un test sérieux : offre Starter (~7 $/mois).
- TiDB Cloud Starter gratuit : quota mensuel limité (voir section 1) ; adapté au test et à un petit pilote, pas à une charge de production.
- Régions : choisissez Render et TiDB dans la **même région** (ex. Francfort) pour la latence.
- Vercel relaie les requêtes : durée maximale limitée, pas de gros envois ; les PDF et pages courantes passent sans problème.
- `npm run backup` (mysqldump) n'est pas prévu pour ce montage : utilisez les sauvegardes de TiDB Cloud.

## 1. TiDB Cloud (base MySQL)
1. Créer un compte sur tidbcloud.com puis une instance **Starter** (compatible MySQL), région Europe (Francfort) si proposée : même région que Render.
2. Bouton **Connect** de l'instance : noter Host, Port (4000), User (de la forme `xxxx.root`, **en entier**), Password (à générer ; il ne s'affiche qu'une fois).
3. Base de données : MHFac utilise `DB_NAME=mhfac` et la crée à la première migration. Si TiDB refuse la création (message « base non creee automatiquement » dans les journaux), créez-la dans la console SQL (`CREATE DATABASE mhfac;`) ou mettez `DB_NAME=test`.
4. TLS : obligatoire, `DB_SSL=true`. **Pas de `DB_SSL_CA` à renseigner** : Node reconnaît le certificat de TiDB Starter.
5. Quota gratuit (docs PingCAP, à revérifier avant usage) : 5 Gio de stockage et 50 millions d'unités de requête (RU) par mois. **Au-delà, les nouvelles connexions sont refusées jusqu'au mois suivant** : surveillez l'onglet d'usage de la console, surtout avec plusieurs entreprises actives.
6. Sauvegardes : `npm run backup` (mysqldump) n'est pas prévu pour ce montage ; vérifiez dans la console TiDB ce qui est sauvegardé pour votre offre avant d'y mettre de vraies données.

## 2. Render (API)
1. *New → Blueprint* → choisir le dépôt GitHub `mhfac` (`render.yaml` à la racine) ; ou *New → Web Service* avec : Root Directory `server`, Build `npm ci --omit=dev`, Start `npm run migrate:cloud && npm run start:cloud`.
2. Saisir les variables : `DB_HOST`, `DB_PORT=4000`, `DB_USER`, `DB_PASSWORD`, `DB_NAME=mhfac`, `DB_SSL=true`, `TRUST_PROXY=2`, `NODE_ENV=production`, `CLIENT_URL=https://<votre-site>.vercel.app`, secrets JWT (générés par Render).
3. Les migrations s'appliquent à chaque démarrage (sans effet si déjà faites).
4. Tester : `https://<votre-api>.onrender.com/api/v1/health` → `status: ok`, `db: up`.
5. Créer le super administrateur : onglet *Shell* de Render, `npm run create-admin:cloud -- --email ... --name ...` (voir ci-dessous) ou, en local, avec le `.env` pointant temporairement vers TiDB.

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
- Aucun secret dans Git : tout est dans les tableaux de bord Render/TiDB/Vercel.
- Les secrets JWT de test ne sont jamais ceux d'un autre environnement.
- E-mails : `MAIL_PROVIDER=smtp` + `SMTP_*` pour des envois réels ; sinon ils s'affichent dans les journaux Render.

## 6. E-mails réels (SMTP)
Par défaut `MAIL_PROVIDER=console` : aucun e-mail ne part (le texte s'écrit dans les journaux). Pour de vrais envois (confirmation de compte, invitations, réinitialisation de mot de passe, rappel d'essai, envoi de factures) :

1. **Render gratuit bloque les ports SMTP 25, 465 et 587** (annonce Render). Le port **2525** n'est pas cité dans ce blocage ; il est proposé par plusieurs services (Brevo, Mailgun, SendGrid). Sur une offre Render payante, tous les ports sont utilisables.
2. Exemple avec **Brevo** (offre gratuite avec quota quotidien, à vérifier sur leur site) : créer un compte, valider l'expéditeur (idéalement le domaine `mh-digital-solution.com` avec les enregistrements SPF/DKIM demandés, sinon e-mails en spam), puis *SMTP & API → SMTP* : noter l'identifiant et générer une **clé SMTP** (pas la clé API).
3. Variables Render : `MAIL_PROVIDER=smtp`, `SMTP_HOST=smtp-relay.brevo.com`, `SMTP_PORT=2525`, `SMTP_USER=<identifiant SMTP>`, `SMTP_PASSWORD=<clé SMTP>`, `MAIL_FROM=MHFac <contact@mh-digital-solution.com>` (adresse validée chez le fournisseur).
4. Test : réinitialiser le mot de passe d'un compte → l'e-mail doit arriver ; sinon lire l'erreur dans les journaux Render.
5. Si le fournisseur est injoignable, la création de compte échoue (le mail de confirmation fait partie de l'inscription) avec une erreur rapide (10 s) : surveiller les journaux après changement de configuration.

