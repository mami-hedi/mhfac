# Phase 2 — Initialisation

## Fait et vérifié
- Serveur Express (ESM) : Helmet, CORS, rate limiting, JSON, journal de requêtes, erreurs au format `{ error: { code, message, details } }`.
- Config validée par Zod au démarrage (le serveur refuse de démarrer avec des secrets absents ou trop courts).
- Pool MySQL (`mysql2`), requêtes paramétrées, DECIMAL en chaînes, helper `withTransaction`.
- Runner de migrations SQL versionnées (idempotent), migration `001_foundation` : companies, company_settings, users, roles, permissions, role_permissions, company_members.
- Route `GET /api/v1/health` (état API + base).
- Client React 18 + Vite 6 + Tailwind 4 + React Router + Axios + Lucide ; proxy `/api` en dev ; page de statut.
- Vérifié : migrations appliquées deux fois sans erreur, 3 tests serveur verts, client → proxy → API → base OK, build client OK.
  (Testé sur MariaDB 10.11 ; MySQL 8 n'a pas été testé ici.)

## Décisions prises par défaut (point de la Phase 1 non tranché)
- Monolithe modulaire, `modules/<nom>/` côté serveur ; identifiants publics UUID en plus des ids internes.
- Numéro de facture attribué à l'émission ; coût moyen pondéré pour le stock ; Puppeteer pour le PDF ; e-mail en mode `console` en développement.
- Notes de débours, Projets, Chèques & Traites : schéma prévu avant la Phase 7, tables non créées en Phase 2.
- Impersonation du super administrateur : non implémentée (à décider en Phase 9).

## Non fait (volontairement)
- Authentification, rôles seedés, isolation multi-tenant : Phase 3.
- shadcn/ui, React Hook Form, Zod côté client, Recharts : ajoutés quand ils servent (Phases 4-5).
- Autres tables du schéma : migrations par domaine à partir de la Phase 3.
