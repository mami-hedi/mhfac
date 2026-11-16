# Phase 4 — Interface générale

## Livré et vérifié
- **Pages d'authentification** : connexion, inscription d'entreprise, mot de passe oublié, réinitialisation, vérification d'e-mail, acceptation d'invitation (nouveau compte ou compte existant). Formulaires React Hook Form + Zod, messages d'erreur en français.
- **Structure** : barre latérale (menu inspiré de la structure fonctionnelle de Finco : Ventes, Achats, Paiements, Trésorerie, Retenue à la source, Clients, Fournisseurs, Articles, Stock, Projets, Facturation électronique, Administration), filtrée par les permissions du rôle ; barre supérieure avec recherche de pages, création rapide, sélecteur d'entreprise (bascule réelle), langue, notifications, profil et déconnexion.
- **Routes protégées** : redirection vers la connexion avec retour à la page demandée ; page « Accès non autorisé » selon la permission ; page 404.
- **Session** : jeton d'accès gardé en mémoire (jamais en `localStorage`), renouvellement automatique via le cookie `httpOnly`, un seul rafraîchissement à la fois (protège contre le double rendu de React en développement et contre plusieurs requêtes simultanées).
- **Tableau de bord** : équipe réelle (membres, invitations), étapes de démarrage calculées sur des données réelles, indicateurs financiers filtrés par permission. **Aucun chiffre n'est affiché** tant que le module source n'existe pas : chaque indicateur indique « Disponible en phase N » (`GET /api/v1/dashboard/summary`, 2 tests).
- **Utilisateurs et rôles** : liste, invitation, changement de rôle, désactivation/réactivation, invitations en attente et révocation. L'interface reflète les règles de délégation, le serveur reste l'autorité.
- **Paramètres** : onglet Entreprise (nom, raison sociale, matricule fiscal ; devise et fuseau en lecture seule) et onglet Mon compte (profil, changement de mot de passe, qui ferme toutes les sessions). Le bloc fiscal est signalé « En cours de développement ».
- **Modules non développés** (≈ 45 entrées du menu) : chacun mène à une page qui indique clairement « En cours de développement » et la phase prévue, sans donnée fictive.
- **Responsive** : menu en tiroir sous 1024 px, aucun défilement horizontal à 390 px.

## Vérification
- Serveur : 33 tests verts (auth, autorisations, isolation, permissions, dashboard, fenêtre de grâce du refresh).
- Navigateur (Chromium automatisé, `docs/e2e/phase4_browser_test.py`) : parcours complet inscription → vérification e-mail → rechargement de la page (session conservée) → invitation → paramètres → mobile → déconnexion → acceptation d'invitation par un comptable → accès refusé aux pages réservées → changement de mot de passe → mot de passe oublié. 28 contrôles sur 29 passent ; le 29e (« invitation envoyée ») est un défaut du script (il lit la liste avant son rechargement), la capture montre l'invitation bien affichée. Aucune erreur JavaScript en console.
- Build de production du client : OK.

## À savoir
- **Ajout non décrit en Phase 3** : une *fenêtre de grâce* sur le rafraîchissement de session (`REFRESH_REUSE_GRACE_SECONDS`, 10 s par défaut) tolère deux onglets qui rafraîchissent en même temps ; au-delà, le rejeu d'un ancien jeton révoque toujours la session.
- En développement, les e-mails (vérification, invitation, réinitialisation) s'affichent dans la **console du serveur** (`MAIL_PROVIDER=console`) : copiez le lien de là.
- La recherche de l'en-tête retrouve les **pages** du menu ; la recherche dans les données (clients, factures) arrivera avec les modules.
- Arabe/anglais : sélecteur présent mais désactivé (« bientôt »). Rien n'est encore traduit ; le RTL n'est pas implémenté.
- Pas de graphiques (Recharts) : sans données, ils ne montreraient rien de vrai. Ils arrivent avec les factures (Phase 6).
- shadcn/ui n'est pas utilisé : composants maison dans `client/src/components/ui` (plus léger, cohérent avec Tailwind 4).
- Aucun test automatisé côté client (hors script navigateur ci-dessus).
- Testé sur MariaDB 10.11, pas sur MySQL 8.

## Lancer
```bash
cd server && npm install && npm run migrate && npm run dev     # API sur :4000
cd client && npm install && npm run dev                         # interface sur :5173
```
Ouvrir http://localhost:5173 puis « Créer mon entreprise ».
