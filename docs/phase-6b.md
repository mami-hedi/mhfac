# Phase 6 (complément) — commandes, livraisons, acompte/solde, récurrentes, e-mail, modèles PDF

Ce complément termine la Phase 6 avant de passer à la Phase 7 (achats, paiements fournisseurs, stock). Règlement des factures : **enregistrement des règlements client** livré (l'ancien « montant réglé reste à 0 » est dépassé, voir § Règlements).

## Périmètre livré
| Fonction | Où |
|---|---|
| Commandes client (`CMD-AAAA-NNNNN`) | `/orders`, écran **Ventes > Commandes client** |
| Bons de livraison (`BL-AAAA-NNNNN`) | `/delivery-notes`, écran **Ventes > Bons de livraison** |
| Facture d'acompte / facture de solde | depuis une commande (`POST /orders/:id/deposit`, `/invoice`) |
| Facture depuis un bon de livraison | `POST /delivery-notes/:id/invoice` |
| Factures récurrentes | `/recurring-invoices`, écran **Ventes > Factures récurrentes** |
| Envoi par e-mail (devis, commande, bon, facture, avoir) | `POST /:id/send`, `GET /:id/emails` |
| Modèles PDF (classique, moderne, minimal) + français / arabe (droite à gauche) | Paramètres > Logo et couleur ; `?template=` et `?lang=` sur `/:id/pdf` |
| Règlements client | `/payments` (liste, création multi-factures, annulation avec motif) |

## Règles métier
- **Commande** : brouillon → confirmée → (annulée). Brouillon modifiable/supprimable ; confirmée figée. Créée de zéro ou depuis un devis *accepté* (montants copiés, devis → « converti »). Livraison (`none/partial/complete`) et facturation (`none/deposit/partial/invoiced`) sont **dérivées** des bons validés et des factures actives, jamais saisies. Annulation refusée s'il existe des bons non annulés ou des factures actives.
- **Bon de livraison** : quantités uniquement (aucun montant), par ligne de commande ; quantité ≤ reste à livrer (bons brouillon + validés comptés, contrôle refait à la validation sous verrou). Numéro attribué à la validation ; validé = figé ; annulation avec motif (≥ 5 car.), refusée si facturé. **Depuis la Phase 7, la validation fait sortir du stock les articles suivis** (voir `docs/phase-7.md`).
- **Facture depuis un bon** : quantités livrées au prix/remise/TVA de la commande, une seule fois par bon ; annuler la facture libère le bon. Interdit si la commande est déjà facturée en entier ou en acompte.
- **Acompte** : % de la commande (cumul ≤ 100 %), une ligne par taux de TVA (base après remise globale, arrondi au millime), sans timbre ni retenue. **Solde** : lignes complètes de la commande ; les acomptes *émis* sont déduits en TTC (`deposit_deducted`, table `invoice_deposits`), `net_payable` = net − acomptes. Un acompte déduit ne peut être ni annulé, ni supprimé, ni crédité tant que la facture de solde existe ; annuler le solde libère les acomptes. Les avoirs sur un solde sont plafonnés à TTC − acomptes. **Pour la Phase 8 (déclaration TVA)** : la TVA des acomptes est déjà portée par les factures d'acompte, la facture de solde porte la TVA totale de la commande ; la déduction se fait en TTC — à neutraliser dans les états de TVA.
- **Récurrentes** : un modèle (client, lignes, remise, notes) validé comme une facture (références, TVA active, devise) engendre des **brouillons** — jamais émis ni envoyés automatiquement. Fréquences : semaine, mois, trimestre, année ; jour de départ conservé en fin de mois (31 janv. → 28 févr. → 31 mars). Rattrapage jusqu'à 12 échéances par exécution ; idempotence par (série, période) unique. Date de la facture générée = date d'exécution (ordre chronologique de la numérotation). Actions : pause / reprise / terminer / générer maintenant ; suppression seulement avant la première génération. Planificateur : toutes les heures, désactivable (`RECURRING_SCHEDULER=off`), verrou de ligne par série (plusieurs instances sans doublon). Si une génération échoue (client archivé, TVA désactivée…) la série n'avance pas et l'erreur est ignorée jusqu'à correction.
- **E-mail** : PDF joint ; seul un document émis/confirmé/validé est envoyable (devis : non expiré/converti) ; 1 à 5 destinataires, objet sans retours à la ligne, 50 e-mails/h/société, journal `document_emails` (succès et échecs), réponses vers l'e-mail de la société.
- **PDF** : 3 modèles × 2 langues. Arabe : polices Cairo (licence OFL, `server/assets/fonts/`), mise en page miroir, libellés traduits ; les mots arabes/latins/chiffres d'une ligne sont ordonnés par le moteur du PDF (pdfkit met les lettres en forme mais n'applique pas l'ordre bidirectionnel). Filigrane BROUILLON / ANNULÉE / REFUSÉ. Choix par défaut dans les paramètres, surchargeable par requête.
- **Règlements** : réglement client affecté à une ou plusieurs factures du même client (jamais plus que le solde), numéro `REG-AAAA-NNNNN`, annulation avec motif (jamais de suppression), `paid_amount` recalculé sous verrou.

## Droits
`sales_order.*` (propriétaire/admin/commercial valident ; comptable/lecture seule lisent), `delivery.*` (+ gestionnaire de stock), factures récurrentes : `invoice.read/write/delete`. Création de facture depuis commande/bon : `invoice.write` en plus.

## Installer / tester
```
cd server && npm install && npm run migrate   # migrations 001-005 (005 : commandes, bons, récurrentes, règlements, e-mails)
npm test                                       # 91 tests
python3 docs/e2e/phase6b_browser_test.py       # API :4000 + client :5173 démarrés (aussi phase6_browser_test.py)
```
Variables : `RECURRING_SCHEDULER=on|off` (nouveau) ; e-mail réel : `MAIL_PROVIDER=smtp`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `MAIL_FROM` (par défaut les e-mails s'affichent dans la console). Aucune nouvelle dépendance npm ; nouvelle ressource : polices Cairo.

## Réellement fait / limites
Fait et vérifié : 20 tests serveur supplémentaires (commandes, livraisons partielles et plafonds, acompte/solde et garde-fous, récurrentes, calcul de dates, PDF des 6 combinaisons) et 30 vérifications navigateur (parcours complet, e-mail, PDF arabe, mobile 390 px, droits d'un lecteur).
Limites : pas d'édition d'un bon de livraison *brouillon* dans l'interface (l'API `PUT` existe : supprimer et recréer) ; pas d'envoi automatique des récurrentes (volontaire) ; pas de mouvement de stock ni de retour (Phase 7) ; arabe limité au document PDF (l'interface reste en français) ; rendu arabe vérifié visuellement sur échantillons, à relire par un lecteur arabophone (terminologie comptable tunisienne, par ex. « المعرّف الجبائي », « الطابع الجبائي ») ; aucune facturation électronique TTN (Phase 8, aucune conformité revendiquée) ; testé uniquement sur MariaDB 10.11 ; pas de test unitaire côté client.
