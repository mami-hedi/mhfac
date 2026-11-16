// Génère docs/API.md depuis les routes RÉELLES de l'application (méthode, chemin, authentification,
// permission, offre requise). La documentation ne peut donc pas dériver du code : relancer après tout changement.
//   npm run docs:api
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { authenticate } from '../src/middlewares/auth.js';
import { authenticatePlatform } from '../src/middlewares/platformAuth.js';
import { pool } from '../src/config/db.js';

const unescape = (src) => src.replace(/^\^/, '').replace(/\\\/\?\(\?=\\\/\|\$\)\$?$/, '').replace(/\\\/\?\$$/, '').replace(/\\\//g, '/').replace(/\(\?:\(\[\^\/\]\+\?\)\)/g, ':param');

function tagsOf(handlers, inherited) {
  const t = { ...inherited, perms: [...(inherited.perms ?? [])] };
  for (const h of handlers) {
    if (h === authenticate) t.auth = 'user';
    else if (h === authenticatePlatform) t.auth = 'platform';
    if (h?.requiredPermissions) t.perms.push(...h.requiredPermissions);
    if (h?.requiredFeature) t.feature = h.requiredFeature;
  }
  return t;
}
function walk(stack, prefix, inherited, out) {
  let scope = { ...inherited };
  for (const l of stack) {
    if (l.route) {
      const t = tagsOf(l.route.stack.map((s) => s.handle), scope);
      for (const m of Object.keys(l.route.methods)) out.push({ method: m.toUpperCase(), path: prefix + l.route.path, ...t });
    } else if (l.name === 'router' && l.handle?.stack) {
      const mount = l.regexp.fast_slash ? '' : unescape(l.regexp.source);
      walk(l.handle.stack, prefix + mount, scope, out);
    } else {
      scope = tagsOf([l.handle], scope); // middleware appliqué à tout ce qui suit dans ce routeur
    }
  }
}
const out = [];
walk(createApp()._router.stack, '', { perms: [] }, out);
const routes = out.filter((r) => r.path.startsWith('/api/v1'));
const groups = new Map();
for (const r of routes) {
  const seg = r.path.split('/')[3] ?? '';
  if (!groups.has(seg)) groups.set(seg, []);
  groups.get(seg).push(r);
}
const authLabel = (r) => (r.auth === 'platform' ? 'Super admin' : r.auth === 'user' ? 'Jeton utilisateur' : 'Publique');
let md = `# API MHFac — référence des routes\n\n> Fichier **généré** par \`npm run docs:api\` depuis le code (${routes.length} routes). Ne pas éditer à la main.\n\n`;
md += `## Conventions\n\n- Base : \`/api/v1\`. JSON partout, sauf exports (CSV/XLSX/PDF) et téléversement de scan (corps brut).\n- Authentification : \`Authorization: Bearer <accessToken>\` (durée courte). Le jeton de rafraîchissement est un cookie httpOnly \`mhfac_rt\` (SameSite=strict, chemin \`/api/v1/auth\`).\n- Succès : \`{ "data": ..., "meta": ... }\`. Erreur : \`{ "error": { "code", "message", "details" } }\`.\n- Codes courants : 400 \`VALIDATION_ERROR\` · 401 \`UNAUTHENTICATED\`/\`INVALID_TOKEN\` · 403 \`FORBIDDEN\` (permission), \`SUBSCRIPTION_INACTIVE\`, \`PLAN_LIMIT_REACHED\`, \`FEATURE_NOT_IN_PLAN\` · 404 (aussi pour une ressource d'une autre entreprise) · 409 conflit métier · 413/415 corps trop gros / encodage refusé · 422 règle métier · 429 trop de requêtes.\n- Identifiants publics : UUID (\`public_id\`). Les identifiants internes ne sont jamais exposés. \`company_id\` vient toujours de la session.\n- Montants : chaînes décimales à 3 décimales (ex. \`"238.000"\`), jamais des flottants. Tous les calculs sont faits par le serveur.\n- Abonnement expiré/résilié : lecture et exports autorisés, écritures refusées (403 \`SUBSCRIPTION_INACTIVE\`).\n- Permissions : \`module.action\` ; matrice complète par rôle : \`GET /api/v1/users/permissions-matrix\`.\n\n`;
for (const [seg, list] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
  md += `## /${seg}\n\n| Méthode | Chemin | Accès | Permission | Offre |\n| --- | --- | --- | --- | --- |\n`;
  for (const r of list) md += `| ${r.method} | \`${r.path.replace('/api/v1', '')}\` | ${authLabel(r)} | ${[...new Set(r.perms)].map((p) => `\`${p}\``).join(', ') || '—'} | ${r.feature ? `\`${r.feature}\`` : '—'} |\n`;
  md += '\n';
}
const dest = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs', 'API.md');
fs.writeFileSync(dest, md);
console.log(`docs/API.md généré : ${routes.length} routes, ${groups.size} groupes.`);
await pool.end();
