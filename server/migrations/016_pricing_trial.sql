-- Tarification et essai gratuit : prix annuel par offre, périodicité de facturation par abonnement.
-- Prix décidés par l'éditeur (modifiables dans l'espace plateforme) : offre « Pro » = 56 TND / mois ou 560 TND / an (2 mois offerts).
-- Aucun paiement en ligne : la périodicité est une information de suivi ; l'échéance est fixée par l'administrateur de la plateforme.
ALTER TABLE subscription_plans
  ADD COLUMN price_yearly DECIMAL(15,3) NULL COMMENT 'NULL = pas de tarif annuel ; modifiable par l''administrateur' AFTER price_monthly;
ALTER TABLE company_subscriptions
  ADD COLUMN billing_period ENUM('monthly','yearly') NULL COMMENT 'périodicité convenue (suivi manuel)' AFTER current_period_end;

UPDATE subscription_plans SET price_monthly = 56.000, price_yearly = 560.000, description = 'Offre standard MHFac' WHERE code = 'pro';
