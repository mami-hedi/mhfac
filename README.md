# MHFac

SaaS de facturation et de gestion commerciale pour la Tunisie, édité par MH Digital Solution.
**État : Phase 9 (abonnements, sécurité, documentation) en attente de validation ; Phases 1 à 8 validées.** Voir `docs/phase-2.md` à `docs/phase-9.md`.

> Facturation électronique = **simulation non homologuée TTN**. Aucun paiement en ligne. Les rapports sont des états de gestion, pas des états comptables certifiés.

## Documentation

| Document | Contenu |
| --- | --- |
| `docs/DEPLOIEMENT.md` | Installation Windows, production, sauvegarde/restauration, limites e-invoicing |
| `docs/API.md` | Référence des 343 routes (générée : `npm run docs:api`) |
| `docs/phase-N.md` | Décisions, tests et limites de chaque phase |
| `server/.env.example`, `server/.env.test.example`, `client/.env.example` | Variables d'environnement |

## Prérequis (Windows ou Linux)

- Node.js 20 LTS ou plus récent (https://nodejs.org)
- MySQL 8 (ou MariaDB 10.6+ pour les tests locaux) avec un utilisateur autorisé à créer une base

## Installation

```bash
# 1. Serveur
cd server
npm install
copy .env.example .env        # Linux/macOS : cp .env.example .env
# -> editer .env : DB_USER, DB_PASSWORD, JWT_*_SECRET (32+ caracteres)
npm run migrate               # cree la base et applique les migrations
npm run dev                   # http://localhost:4000/api/v1/health

# 2. Client (autre terminal)
cd client
npm install
copy .env.example .env
npm run dev                   # http://localhost:5173
```

Le client en développement relaie `/api` vers le serveur (proxy Vite) : aucune URL n'est codée en dur.

## Vérification

- Ouvrir http://localhost:5173 puis « Créer mon entreprise » pour créer votre compte. La page technique de santé reste disponible sur `/status`.
- Tests serveur : `copy .env.test.example .env.test` (adapter `DB_USER`/`DB_PASSWORD`), créer la base `mhfac_test`, puis `node --env-file=.env.test scripts/migrate.js` et `npm test`.
  
## Commandes

| Dossier | Commande | Effet |
| --- | --- | --- |
| server | `npm run dev` | API avec rechargement |
| server | `npm run migrate` / `migrate:status` | Applique / liste les migrations |
| server | `npm test` | 239 tests (node:test) |
| server | `npm run create-admin -- --email ... --name ...` | Crée le super administrateur de la plateforme |
| server | `npm run seed-demo` | Entreprise de démonstration fictive (jamais en production) |
| server | `npm run backup` / `restore -- <fichier> --yes` | Sauvegarde / restauration de la base |
| server | `npm run docs:api` | Régénère `docs/API.md` |
| client | `npm run dev` / `build` | Serveur de dev / build de production |

## Structure

```
client/   React + Vite + Tailwind 4
server/   Express (ESM) : src/{config,middlewares,modules,core,integrations,jobs,utils}, migrations/, seeds/, tests/
docs/     Architecture (Phase 1 : document partagé), décisions, notes de phase
```

## Règles du projet

- Aucune règle financière dans le client : le serveur calcule, valide et décide des statuts.
- Toutes les données métier portent `company_id`, tiré de la session, jamais du client.
- Montants en `DECIMAL`, lus en chaînes côté Node (`decimalNumbers: false`).
- Aucune conformité TTN / facturation électronique n'est revendiquée ; l'adaptateur de simulation est clairement étiqueté.
- Un document émis ou validé n'est jamais modifié ni supprimé silencieusement (annulation/avoir tracés).
- Aucune donnée financière factice dans les modules ; les données de démo sont séparées, étiquetées fictives, et créées via l'API.

## Sécurité

Rapport d'audit, failles corrigées, risques résiduels et réglages de production : [docs/SECURITE.md](docs/SECURITE.md).
