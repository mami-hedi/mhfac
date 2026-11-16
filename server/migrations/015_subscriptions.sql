-- Phase 9A : offres d'abonnement SaaS configurables (aucun prix figé dans le code) et abonnement de chaque entreprise.
-- Aucun paiement en ligne n'est géré : le plan d'une entreprise est attribué par l'administrateur de la plateforme.
CREATE TABLE subscription_plans (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  code          VARCHAR(40)  NOT NULL,
  name          VARCHAR(100) NOT NULL,
  description   VARCHAR(500) NULL,
  price_monthly DECIMAL(15,3) NULL COMMENT 'NULL = prix non défini / sur devis ; modifiable par l''administrateur',
  currency      CHAR(3)      NOT NULL DEFAULT 'TND',
  limits        JSON         NOT NULL COMMENT '{users,invoicesPerMonth,warehouses,scansPerMonth,exportsPerMonth} ; null = illimité',
  features      JSON         NOT NULL COMMENT '{einvoice,purchaseScan,reportsExport,support}',
  is_active     TINYINT(1)   NOT NULL DEFAULT 1 COMMENT '0 = non attribuable à de nouvelles entreprises',
  is_public     TINYINT(1)   NOT NULL DEFAULT 1 COMMENT '1 = affichée aux entreprises dans « Mon abonnement »',
  sort_order    INT          NOT NULL DEFAULT 0,
  created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_plan_code (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE company_subscriptions (
  company_id         BIGINT UNSIGNED NOT NULL,
  plan_id            BIGINT UNSIGNED NOT NULL,
  status             ENUM('trial','active','past_due','cancelled') NOT NULL DEFAULT 'active',
  trial_ends_at      DATETIME NULL,
  current_period_end DATETIME NULL COMMENT 'NULL = sans échéance',
  notes              VARCHAR(500) NULL,
  updated_by         BIGINT UNSIGNED NULL,
  created_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (company_id),
  CONSTRAINT fk_cs_company FOREIGN KEY (company_id) REFERENCES companies (id),
  CONSTRAINT fk_cs_plan FOREIGN KEY (plan_id) REFERENCES subscription_plans (id),
  CONSTRAINT fk_cs_user FOREIGN KEY (updated_by) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE subscription_events (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  company_id  BIGINT UNSIGNED NOT NULL,
  event       VARCHAR(40)  NOT NULL,
  detail      JSON NULL,
  created_by  BIGINT UNSIGNED NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_se_company (company_id, id),
  CONSTRAINT fk_se_company FOREIGN KEY (company_id) REFERENCES companies (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Offres de départ : LIMITES INDICATIVES à ajuster dans l'espace plateforme ; aucun prix (price_monthly NULL) tant que l'administrateur n'en définit pas.
INSERT INTO subscription_plans (code, name, description, limits, features, sort_order) VALUES
 ('decouverte', 'Découverte', 'Pour essayer MHFac', '{"users":1,"invoicesPerMonth":10,"warehouses":1,"scansPerMonth":5,"exportsPerMonth":5}', '{"einvoice":false,"purchaseScan":true,"reportsExport":false,"support":"Communauté"}', 10),
 ('auto_entrepreneur', 'Auto-entrepreneur', 'Pour une activité individuelle', '{"users":2,"invoicesPerMonth":50,"warehouses":1,"scansPerMonth":30,"exportsPerMonth":30}', '{"einvoice":false,"purchaseScan":true,"reportsExport":true,"support":"E-mail"}', 20),
 ('pro', 'Pro', 'Pour une petite entreprise', '{"users":5,"invoicesPerMonth":300,"warehouses":3,"scansPerMonth":150,"exportsPerMonth":200}', '{"einvoice":true,"purchaseScan":true,"reportsExport":true,"support":"E-mail prioritaire"}', 30),
 ('business', 'Business', 'Pour une entreprise multi-utilisateurs', '{"users":25,"invoicesPerMonth":null,"warehouses":10,"scansPerMonth":1000,"exportsPerMonth":null}', '{"einvoice":true,"purchaseScan":true,"reportsExport":true,"support":"Support dédié"}', 40);

-- Les entreprises déjà existantes (avant cette migration) conservent un accès complet : plan « business ».
INSERT INTO company_subscriptions (company_id, plan_id, status, notes)
  SELECT c.id, (SELECT id FROM subscription_plans WHERE code = 'business'), 'active', 'Attribué automatiquement lors de la migration 015' FROM companies c;
