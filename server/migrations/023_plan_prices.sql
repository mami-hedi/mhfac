-- Tarifs publics des offres, alignés sur la page d'accueil : Auto-entrepreneur 31 TND/mois (310 TND/an), Business 129 TND/mois (1 290 TND/an).
-- Découverte reste « sur demande » ; Pro (56 / 560) est déjà posé par la migration 016.
-- Garde-fou : on ne touche qu'à une offre JAMAIS tarifée (prix NULL) ; un prix déjà fixé par l'administrateur n'est jamais écrasé.
-- Auto-entrepreneur : 1 utilisateur (offre individuelle), comme annoncé sur la page d'accueil.
UPDATE subscription_plans
   SET price_monthly = 31.000, price_yearly = 310.000,
       limits = JSON_SET(limits, '$.users', 1)
 WHERE code = 'auto_entrepreneur' AND price_monthly IS NULL AND price_yearly IS NULL;
UPDATE subscription_plans
   SET price_monthly = 129.000, price_yearly = 1290.000
 WHERE code = 'business' AND price_monthly IS NULL AND price_yearly IS NULL;
