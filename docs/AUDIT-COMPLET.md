# MHFac — Audit complet : sécurité, robustesse, concurrence, performance (7 novembre 2026)

Méthode : revue du code, `npm audit`, et **quatre campagnes de tests automatiques** ajoutées à la suite (245 tests, tous verts). Aucune méthode ne prouve l'absence totale de bug ; ces tests prouvent que les défauts connus sont corrigés et empêchent leur retour.

## 1. Défauts trouvés et corrigés
| # | Gravité | Défaut | Correction | Test |
| --- | --- | --- | --- | --- |
| C1 | **Critique** | **Règlements simultanés pouvant dépasser le solde d'une facture.** Sous l'isolation MySQL par défaut (REPEATABLE READ), le recalcul de `paid_amount` lisait un instantané périmé et écrasait le résultat d'une transaction concurrente : 6 règlements de 40 sur une facture de 119 étaient tous acceptés, le montant payé restant affiché à 40. | Isolation **READ COMMITTED** sur toutes les connexions (`config/db.js`) ; les accès concurrents restent sérialisés par `SELECT … FOR UPDATE`. | `concurrency.test.js` |
| C2 | **Critique (introduit par la mise à niveau)** | **Zod 4 applique les valeurs par défaut aux champs absents d'un PATCH** : une modification partielle d'un client ou d'un article aurait remis à zéro délai de paiement, devise, pays, unité, prix… sans erreur visible. | Marqueur `asPatch` : seuls les champs réellement envoyés sont conservés ; PATCH vide → 400. | `security_audit.test.js` (PATCH partiel) |
| S1 | Moyenne | Contournement du mode « abonnement expiré » par `?x=/auth/` | Contrôle sur le chemin seul, ancré | `security_audit.test.js` F1 |
| S2 | Moyenne | Limite de débit mal ciblée (déconnexions possibles) + pas de limite par e-mail | Limite stricte ciblée, 3 e-mails de réinitialisation / heure / adresse | F2, F4 |
| S3 | Faible | Fuite par délai sur « mot de passe oublié » ; mots de passe faibles ; bcrypt tronquant à 72 octets | Envoi non bloquant ; liste de mots de passe courants ; limite 72 octets | F3, F4 |
| S4 | Moyenne | Inscription ouverte : envoi d'e-mails depuis votre serveur par des comptes non confirmés | E-mails de documents refusés tant que l'adresse n'est pas confirmée | `security_audit.test.js` |
| S5 | Haute (npm) | `zod` < 4.6.6 : épuisement mémoire ; `body-parser` vulnérable | zod 4.6.7 ; body-parser 1.20.9 | `npm audit` |
| R1 | Moyenne | Une promesse rejetée hors d'une route (envoi d'e-mail, tâche planifiée) **arrêtait tout le serveur** (Node 22) ; arrêt brutal sans attendre les requêtes en cours | Journalisation sans arrêt pour les rejets ; arrêt propre (10 s) ; délais de requête explicites | — |
| R2 | Moyenne | File d'attente de connexions MySQL illimitée | `queueLimit` 200, `DB_POOL_SIZE`, délai de connexion 10 s, keep-alive | — |
| U1 | Moyenne | Une erreur d'affichage laissait une **page blanche** | `ErrorBoundary` (message clair + recharger) | — |
| P1 | Faible | Premier chargement : un seul fichier JavaScript de 840 Ko | Chargement à la demande par écran : **381 Ko** au premier affichage | navigateur |

## 2. Campagnes de tests ajoutées
- **`fuzz.test.js`** — toutes les routes d'écriture (POST / PUT / PATCH / DELETE) reçoivent plus de 40 corps hostiles (injection SQL, scripts, chaînes de 100 000 caractères, nombres extrêmes, types faux, UUID invalides, dates impossibles) et des montants extrêmes sur de vrais documents : **aucune réponse 5xx**.
- **`concurrency.test.js`** — requêtes simultanées : double émission d'une facture (un seul gagnant), 12 émissions en parallèle (numéros uniques **sans trou**), règlements simultanés (jamais plus que le solde), avoirs simultanés (jamais plus que facturé), double inscription (un seul compte), deux onglets rafraîchissant la session, double validation d'un bon de stock (stock déplacé une fois), sorties simultanées avec stock négatif interdit (jamais négatif).
- **`security_audit.test.js`** — non-régression de chaque faille corrigée.

## 3. Performance (banc d'essai `npm run bench`, base MySQL locale)
Jeu de données : **12 entreprises**, ~88 000 factures, 424 000 lignes, 68 000 règlements, 22 000 achats, 182 000 mouvements de stock, 280 000 lignes d'audit (~2 ans).

| Écran | Médiane |
| --- | --- |
| Liste de factures (page 1 / page 300) | 38 ms / 45 ms |
| Recherche par numéro / par article | 160 ms / 194 ms |
| Filtre statut + dates + client | 5 ms |
| Détail d'une facture / PDF | 5 ms / 17 ms |
| Export CSV (jusqu'à 5 000 lignes) | 143 ms |
| Soldes clients / fournisseurs | 52 ms / 10 ms |
| Détail solde + ancienneté / relevé | 39 ms / 6 ms |
| Tableau de bord | 114 ms |
| Rapport des ventes (année complète) | 69 ms |
| Stock : niveaux / mouvements | 4 ms / 24 ms |
| **Rafale** : 48 listes de factures simultanées (12 entreprises) | 26 ms par requête |
| **Rafale** : 24 tableaux de bord simultanés | 84 ms par requête |

**Aucune requête au-dessus de 500 ms.** Les index existants (439) couvrent les accès fréquents ; aucun index supplémentaire n'a été nécessaire à cette volumétrie. Mesures faites sur une machine de développement, sans réseau : ajoutez la latence du réseau (50 à 100 ms Tunisie → Europe) et vérifiez sur le serveur réel.

Points de vigilance à plus grande échelle (≥ 10× ce volume) : la recherche texte `LIKE '%…%'` (160-190 ms) devra passer à un index plein texte ; le tableau de bord (114 ms) pourra être mis en cache quelques secondes ; la lecture des scans (OCR) reste la fonction la plus gourmande : prévoir 2 vCPU libres.

## 4. Limites assumées (à connaître)
- Ce n'est pas un audit réalisé par un tiers ni un test d'intrusion.
- La facturation électronique est une **simulation** ; la préparation TEJ n'est pas une déclaration officielle (schéma XSD officiel non validé).
- Pas encore : double authentification du super administrateur, anti-robot à l'inscription, chiffrement des pièces scannées en base, supervision externe. Voir `docs/SECURITE.md`.
- Un test de charge sur le serveur de production réel (réseau, disque, RAM) reste à faire avant l'ouverture publique.
