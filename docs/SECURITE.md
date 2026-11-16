# MHFac — Audit de sécurité (6 novembre 2026)

Audit interne du code (revue manuelle + `npm audit` + tests de non-régression). Ce n'est **pas** un test d'intrusion réalisé par un tiers : avant une ouverture publique avec de vraies données clients, faites-en réaliser un.

## Ce qui est déjà solide (vérifié dans le code)
- **Isolation entre entreprises** : `company_id` vient uniquement du jeton signé + table `company_members`, relue à chaque requête ; accès à une autre entreprise → 404. Test automatique : aucune route métier accessible sans authentification (`security.test.js`, `isolation.test.js`).
- **Sessions** : jeton d'accès court (15 min, HS256, émetteur vérifié) gardé en mémoire côté navigateur (jamais `localStorage`) ; jeton de rafraîchissement en cookie `httpOnly`, `Secure`, `SameSite=Strict`, limité à `/api/v1/auth`, **haché** en base, **rotation** à chaque usage et révocation de toute la famille en cas de réutilisation.
- **Mots de passe** : bcrypt, comparaison à durée constante même pour un e-mail inconnu, verrouillage du compte après 5 échecs (15 min), jetons de réinitialisation/invitation/vérification hachés, à usage unique et expirants.
- **Injection SQL** : requêtes paramétrées partout ; les tris dynamiques passent par une liste blanche (`orderBy`).
- **Fichiers téléversés** : type déterminé par les octets du fichier (pas par l'extension ni l'en-tête), taille limitée, SHA-256 anti-doublon, plafond de scans par heure ; logo PNG/JPEG vérifié (pas de SVG).
- **Exports CSV** : protection contre l'injection de formules Excel (`=`, `+`, `-`, `@`).
- **Client** : aucun `innerHTML` / `dangerouslySetInnerHTML` / `eval`.
- **API** : `helmet`, CORS en liste blanche, limite générale par IP, corps JSON limité à 1 Mo, erreurs internes masquées en production, lien des e-mails construit depuis `CLIENT_URL` (pas depuis l'en-tête `Host`).
- **Espace plateforme** : droit super administrateur lu en base à chaque requête, sans accès aux données métier des entreprises.

## Failles trouvées et corrigées
| # | Gravité | Problème | Correction | Test |
| --- | --- | --- | --- | --- |
| F1 | Moyenne | **Contournement du mode « abonnement expiré »** : le contrôle de lecture seule testait toute l'URL ; ajouter `?x=/auth/` à une requête d'écriture la débloquait. | Test sur le **chemin seul**, ancré (`^/api/v1/(auth\|subscription\|notifications)`). | `security_audit.test.js` F1 |
| F2 | Moyenne | **Limite de débit mal ciblée** : 20 requêtes / 15 min / IP partagées entre `/login` et `/auth/me`, `/refresh`. Un utilisateur légitime (ou un bureau derrière une même IP) pouvait être déconnecté ; en contrepartie rien ne limitait par adresse e-mail. | Limite stricte seulement sur `login`, inscription, mot de passe oublié/réinitialisation, vérification, invitation, changement de mot de passe. `/me` et `/refresh` sous la limite générale. | F2 |
| F3 | Moyenne | **Inondation d'e-mails** : « mot de passe oublié » pouvait être répété pour inonder la boîte d'une victime. | 3 e-mails par heure et par adresse (en plus de la limite par IP). | F4 |
| F4 | Faible | **Énumération de comptes par délai** : l'envoi du mail ralentissait la réponse uniquement pour un compte existant. | Envoi non bloquant : même durée de réponse. | F4 |
| F5 | Faible | **Mots de passe faibles acceptés** (`Password123`, `1111111111`…) et mots de passe > 72 octets tronqués silencieusement par bcrypt. | Liste de mots de passe courants refusés, caractères répétés refusés, 72 octets maximum. | F3 |
| F6 | Faible | Dépendance `body-parser` vulnérable (déni de service). | Mise à jour (1.20.9). | `npm audit` |

## Interface
- Œil « afficher / masquer le mot de passe » sur **tous** les champs de mot de passe (connexion, inscription, invitation, réinitialisation, changement de mot de passe), accessible au clavier et aux lecteurs d'écran ; masqué par défaut.

## Risques résiduels (acceptés ou à traiter)
| Sujet | Détail | Recommandation |
| --- | --- | --- |
| `zod` | **Résolu** : migration vers zod 4.6.7 (voir `docs/AUDIT-COMPLET.md`). | — |
| `exceljs` / `uuid` (modérée) | Faille de `uuid` v3-v5 avec un tampon fourni ; non utilisée ainsi. | Surveiller les mises à jour d'`exceljs`. |
| Inscription ouverte | N'importe qui peut créer une entreprise. **Atténué** : l'envoi de documents par e-mail exige une adresse confirmée. | Ajouter un anti-robot (captcha) avant l'ouverture publique. |
| Message « e-mail déjà utilisé » | À l'inscription, révèle qu'une adresse a un compte (compromis d'ergonomie, limité par le débit). | Acceptable ; à changer si la confidentialité des adresses devient critique. |
| Verrouillage de compte | 5 échecs verrouillent 15 min : un tiers peut gêner un utilisateur précis (déni de service ciblé). | Acceptable ; ajouter un CAPTCHA après 3 échecs si observé. |
| Envoi de documents par e-mail | Un utilisateur authentifié peut envoyer un PDF à des tiers via votre SMTP (plafond 50 / h / entreprise, journalisé). | Configurer **SPF, DKIM, DMARC** sur le domaine d'envoi ; surveiller les envois. |
| Super administrateur | Un seul facteur (mot de passe). | Ajouter une authentification à deux facteurs (TOTP) pour ce rôle. |
| Pièces scannées stockées en base | Les données sont en clair dans MySQL. | Chiffrer le disque du serveur ; sauvegardes chiffrées et copiées hors du serveur. |
| Journaux | Les journaux de requêtes contiennent les URL (filtres, pas de secrets). | Ne jamais y ajouter de corps de requête ; limiter l'accès aux journaux. |

## À configurer en production (hors code)
1. **HTTPS obligatoire** (le cookie de session est `Secure`). Redirection HTTP → HTTPS.
2. **En-têtes de sécurité du site** (Caddy), à ajouter dans le bloc du domaine :
   ```
   header {
     Strict-Transport-Security "max-age=31536000; includeSubDomains"
     X-Content-Type-Options "nosniff"
     X-Frame-Options "DENY"
     Referrer-Policy "strict-origin-when-cross-origin"
     Permissions-Policy "camera=(), microphone=(), geolocation=()"
     Content-Security-Policy "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
   }
   ```
   À tester après chaque changement : l'aperçu PDF utilise des `blob:`.
3. **Secrets** : `.env` hors de Git (`.gitignore` renforcé), secrets JWT neufs et différents par environnement, rotation en cas de fuite.
4. **Serveur** : pare-feu (22, 80, 443 seulement), SSH par clé sans mot de passe root, mises à jour automatiques, MySQL non exposé, utilisateur MySQL dédié aux droits limités.
5. **Sauvegardes** quotidiennes chiffrées, copie hors serveur, test de restauration trimestriel.
6. **GitHub** : dépôt privé, double authentification, Dependabot, Secret scanning, protection de `main`.
7. **Supervision** : alerte d'indisponibilité sur `/api/v1/health`, revue régulière des journaux d'audit (`auth.login_failed`, `auth.refresh_reuse_detected`, `auth.account_locked`).

## Rappel important
- La facturation électronique reste une **simulation** ; la préparation TEJ n'est pas une déclaration officielle.
- Les mots de passe de test (`Zebre-Violet-2026`) ne doivent jamais servir en production.
