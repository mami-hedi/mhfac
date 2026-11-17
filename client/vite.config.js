import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Référencement : l'adresse publique du site (VITE_SITE_URL, sans « / » final) remplace %SITE_URL% dans index.html
// et sert à générer robots.txt et sitemap.xml. Vide en développement : les liens restent relatifs.
function seo(siteUrl) {
  return {
    name: 'mhfac-seo',
    transformIndexHtml: (html) => html.replaceAll('%SITE_URL%', siteUrl),
    generateBundle() {
      const rules = ['User-agent: *', 'Allow: /$', 'Allow: /landing/', 'Allow: /og-image.jpg', 'Disallow: /api/', 'Disallow: /platform', 'Disallow: /login', 'Disallow: /register', 'Disallow: /forgot-password', 'Disallow: /reset-password', 'Disallow: /verify-email', 'Disallow: /accept-invitation', 'Disallow: /subscription', 'Disallow: /status'];
      if (siteUrl) rules.push('', `Sitemap: ${siteUrl}/sitemap.xml`);
      this.emitFile({ type: 'asset', fileName: 'robots.txt', source: rules.join('\n') + '\n' });
      if (siteUrl) {
        const day = new Date().toISOString().slice(0, 10);
        this.emitFile({ type: 'asset', fileName: 'sitemap.xml', source: `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>${siteUrl}/</loc><lastmod>${day}</lastmod><changefreq>weekly</changefreq><priority>1.0</priority></url>\n</urlset>\n` });
      }
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  // VITE_SITE_URL en priorité ; sinon, sur Vercel, l'adresse de production fournie par la plateforme (sans elle les aperçus de lien
  // Messenger/WhatsApp/Facebook affichent « / », car og:url et og:image restent relatifs).
  const vercelHost = process.env.VERCEL_PROJECT_PRODUCTION_URL || env.VERCEL_PROJECT_PRODUCTION_URL || '';
  const siteUrl = (env.VITE_SITE_URL || (vercelHost ? `https://${vercelHost}` : '')).replace(/\/+$/, '');
  return {
    plugins: [react(), tailwindcss(), seo(siteUrl)],
    server: {
      port: 5173,
      // En dev, /api est relaye vers le serveur : pas de CORS ni d'URL en dur dans le code.
      proxy: { '/api': { target: env.VITE_API_PROXY || 'http://localhost:4000', changeOrigin: true } },
    },
  };
});
