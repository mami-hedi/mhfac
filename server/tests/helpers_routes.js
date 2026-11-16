// Énumère toutes les routes Express (méthode + chemin) pour les tests de sécurité systématiques.
const unescape = (src) => src.replace(/^\^/, '').replace(/\\\/\?\(\?=\\\/\|\$\)\$?$/, '').replace(/\\\/\?\$$/, '').replace(/\\\//g, '/').replace(/\(\?:\(\[\^\/\]\+\?\)\)/g, ':param');
function walk(stack, prefix, out) {
  for (const l of stack) {
    if (l.route) {
      for (const m of Object.keys(l.route.methods)) out.push({ method: m.toUpperCase(), path: prefix + l.route.path });
    } else if (l.name === 'router' && l.handle?.stack) {
      const mount = l.regexp.fast_slash ? '' : unescape(l.regexp.source);
      walk(l.handle.stack, prefix + mount, out);
    }
  }
}
export function listRoutes(app) { const out = []; walk(app._router.stack, '', out); return out.filter((r) => r.path.startsWith('/api/v1')); }
