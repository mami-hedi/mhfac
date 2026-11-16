# Phase 3 — Authentification et SaaS

## Livré et testé (29 tests serveur verts, 0 échec)
- **Inscription d'entreprise** : entreprise + premier compte propriétaire dans une transaction, e-mail de vérification, session ouverte.
- **Connexion / déconnexion**, verrouillage progressif (`LOGIN_MAX_FAILURES`, `LOGIN_LOCK_MINUTES`), message identique pour e-mail inconnu et mot de passe faux (hash factice pour égaliser le temps de réponse).
- **Sessions** : jeton d'accès JWT HS256 de 15 min (corps de réponse) + jeton de rafraîchissement aléatoire, **stocké haché (SHA-256)**, en cookie `httpOnly`, `SameSite=Strict`, `Secure` en production, limité au chemin `/api/v1/auth`. Rotation à chaque refresh ; un jeton déjà utilisé qui revient révoque toute la famille.
- **Mot de passe oublié** (réponse 202 identique que le compte existe ou non, lien 1 h, usage unique, révocation de toutes les sessions), **changement de mot de passe**, **vérification d'e-mail** (48 h, usage unique).
- **Rôles et permissions** : 6 rôles d'entreprise, 70 permissions `module.action`, matrice de la Phase 1 dans `src/core/permissions.js`, synchronisée en base à chaque `npm run migrate`. Vérifiée par `requirePermission` sur chaque route.
- **Invitations** : création, liste, révocation, acceptation (nouveau compte ou compte existant avec son mot de passe), usage unique, 7 jours.
- **Gestion des membres** : liste, changement de rôle, désactivation/réactivation (accès coupé immédiatement). Règles : le rôle propriétaire n'est jamais attribuable ni modifiable ; seul le propriétaire gère les administrateurs ; on ne modifie pas son propre rôle.
- **Multi-entreprises** : un compte peut appartenir à plusieurs entreprises avec des rôles différents ; `POST /auth/switch-company`.
- **Isolation** : l'entreprise vient du jeton signé **et** de `company_members` relu en base à chaque requête (membre ou entreprise désactivé = 403 immédiat). En-têtes, query et corps envoyés par le client sont ignorés. Une ressource d'une autre entreprise répond 404.
- **Audit** : `audit_logs` (inscription, connexions, échecs, verrouillage, changements de rôle, invitations, réinitialisations ; jamais de secret).

## Endpoints ajoutés
| Route | Accès |
| --- | --- |
| `POST /auth/register-company`, `login`, `refresh`, `logout`, `forgot-password`, `reset-password`, `verify-email`, `accept-invitation` | Public (limité à `AUTH_RATE_LIMIT_MAX` / 15 min / IP) |
| `GET /auth/me`, `POST /auth/change-password`, `POST /auth/switch-company` | Connecté |
| `GET /companies/current` | Tout membre |
| `PATCH /companies/current` | `settings.write` |
| `GET /users`, `/users/roles`, `/users/invitations` | `user.read` |
| `POST /users/invitations`, `DELETE /users/invitations/:id`, `PATCH /users/:id/role`, `PATCH /users/:id/status` | `user.write` |

## Tester
```bash
cd server
npm install
# base de test : utilisateur et base correspondant a .env.test (ex. mhfac_test)
node --env-file=.env.test scripts/migrate.js
npm test
```
Les e-mails sont affichés dans la console (`MAIL_PROVIDER=console`) ; en `smtp`, renseigner `SMTP_*` et `MAIL_FROM`.

## Variables d'environnement nouvelles
`MAIL_PROVIDER`, `SMTP_HOST/PORT/USER/PASSWORD`, `MAIL_FROM`, `AUTH_RATE_LIMIT_MAX`, `LOGIN_MAX_FAILURES`, `LOGIN_LOCK_MINUTES`, `BCRYPT_ROUNDS` (voir `.env.example`).

## Cas limites vérifiés
Jeton falsifié, jeton valide pour une entreprise dont on n'est pas membre, rejeu de refresh, invitation rejouée ou révoquée, auto-modification de rôle, désactivation pendant une session, e-mail déjà pris, mot de passe faible.
Un test de mutation (suppression du filtre `company_id` d'une requête) fait bien échouer le test d'isolation.

## Limites et reste à faire
- **Pas d'interface** (connexion, inscription, gestion des utilisateurs) : Phase 4. Le client n'appelle encore que `/health`.
- **CSRF** : pas de jeton dédié ; protection par cookie `SameSite=Strict` limité à `/auth`, CORS restreint à `CLIENT_URL`, et jeton d'accès en en-tête `Authorization` (pas en cookie). À réévaluer si le client et l'API sont sur des domaines différents.
- E-mails réels non testés (aucun SMTP disponible ici) ; seul le mode console est testé.
- Espace super administrateur (`/platform`), quotas d'abonnement, double authentification, renvoi de l'e-mail de vérification : non faits (Phase 9 ou ultérieurs).
- Pas de nettoyage automatique des jetons expirés (tâche planifiée à ajouter avec les jobs).
- Testé sur MariaDB 10.11, pas sur MySQL 8.
