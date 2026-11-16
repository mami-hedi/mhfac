# Phase 7C — Retenue à la source, notes de débours, projets

## Livré
- **Retenue à la source (RS)** — menus « RS Ventes » et « RS Achats / Autres ».
  - Les listes sont **dérivées des factures** : ventes = factures émises avec un taux de retenue ; achats = factures d'achat enregistrées avec retenue. Le montant, le taux et le TTC viennent de la facture et ne sont jamais saisis ici.
  - Suivi de l'attestation (table `withholding_certificates`) : en attente / reçue (ventes) ou délivrée (achats), avec n°, date, note ; totaux « retenues / attestées / en attente ».
  - Le formulaire de facture d'achat accepte désormais le **taux de retenue** (affichage de la retenue et du net à payer au fournisseur).
  - Droits : lecture pour tous les rôles autorisés, modification réservée à owner / admin / accountant.
- **Notes de débours** (ventes `DEB-AAAA-NNNNN`, achats `DBA-AAAA-NNNNN`) : lignes (désignation, tiers payé, n° de justificatif, montant), **sans TVA ni marge**, devise de l'entreprise. Brouillon modifiable/supprimable ; validation = numéro définitif et note figée ; annulation avec motif ; historique ; rattachement optionnel à un projet.
- **Projets** : code automatique `PRJ-AAAA-NNN` (ou saisi), client, dates, budget de dépenses, statut (en cours / en pause / terminé / annulé). Rattachement de devis, commandes client, factures, avoirs, commandes fournisseur, factures d'achat, avoirs fournisseur et notes de débours (métadonnée : aucun montant ni statut de document n'est modifié). Synthèse : facturé (net d'avoirs), achats (net d'avoirs), marge = facturé − achats, résultat = facturé + débours refacturés − achats − débours payés, budget restant et % consommé. Seuls les documents émis / enregistrés / validés comptent ; les montants HT sont convertis au taux du document.

## Décisions techniques
- Aucun montant dupliqué : RS et synthèse projet sont toujours recalculés depuis les documents (arithmétique entière signée).
- Un document ne peut appartenir qu'à un projet ; document de vente d'un autre client que celui du projet refusé (422 `CLIENT_MISMATCH`) ; projet terminé/annulé : plus de rattachement ; suppression de projet refusée tant qu'il a des documents (409).
- Le reversement de la retenue à l'administration et les déclarations fiscales ne sont **pas** gérés ; l'application ne revendique aucune conformité TTN / facturation électronique.

## Migration
`011_withholding_expenses_projects.sql` → `npm run migrate`.

## Tests
`cd server && npm test` (123 tests) ; navigateur : `python3 docs/e2e/phase7c_browser_test.py` (9 contrôles).

## Cas limites couverts
Brouillon exclu des listes RS et de la synthèse ; facture sans retenue refusée pour attestation (404) ; attestation « reçue » sans n°/date (422) ; note de débours à date future (422) ; montant nul (400) ; modification/suppression d'une note validée (409) ; croisement ventes/achats (404) ; isolation entre entreprises.

## Limites connues
Les notes de débours ne sont pas (encore) refacturables automatiquement sur une facture de vente ni réglées via un règlement dédié ; le rattachement projet se fait depuis la fiche projet (et l'éditeur de note de débours), pas depuis les éditeurs de devis/factures.
