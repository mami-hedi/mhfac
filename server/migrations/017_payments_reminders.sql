-- Paiement de l'abonnement par VIREMENT BANCAIRE (aucun paiement en ligne) + rappel de fin d'essai.
-- 1) Coordonnées bancaires de l'éditeur : une seule ligne, modifiable dans l'espace plateforme.
--    Les valeurs fournies ci-dessous sont des VALEURS DE REMPLACEMENT : is_configured = 0 tant que l'administrateur ne les a pas enregistrées ;
--    les entreprises ne voient JAMAIS ces valeurs de remplacement (elles verraient des coordonnées fausses).
CREATE TABLE platform_payment_info (
  id             TINYINT UNSIGNED NOT NULL,
  beneficiary    VARCHAR(150) NOT NULL,
  bank_name      VARCHAR(150) NOT NULL,
  rib            VARCHAR(40)  NOT NULL COMMENT 'RIB tunisien (20 chiffres)',
  iban           VARCHAR(40)  NULL,
  bic            VARCHAR(20)  NULL,
  contact_email  VARCHAR(190) NULL,
  contact_phone  VARCHAR(40)  NULL,
  instructions   VARCHAR(1000) NULL COMMENT 'consignes affichées au client (libellé du virement, délai de traitement…)',
  is_configured  TINYINT(1)   NOT NULL DEFAULT 0,
  updated_by     BIGINT UNSIGNED NULL,
  updated_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  CONSTRAINT chk_ppi_single CHECK (id = 1),
  CONSTRAINT fk_ppi_user FOREIGN KEY (updated_by) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO platform_payment_info (id, beneficiary, bank_name, rib, iban, bic, contact_email, contact_phone, instructions, is_configured) VALUES
 (1, 'MH DIGITAL SOLUTION (À COMPLÉTER)', 'NOM DE LA BANQUE (À COMPLÉTER)', '00 000 0000000000000 00', 'TN59 0000 0000 0000 0000 0000', 'XXXXTNTT', NULL, NULL,
  'Indiquez la référence de virement ci-dessous dans le libellé. Votre abonnement est activé après vérification du virement par notre équipe.', 0);

-- 2) Déclarations de paiement : le client déclare un virement, l'administrateur le vérifie sur son relevé puis le confirme (ce qui active l'abonnement) ou le rejette.
--    Le montant attendu est calculé par le serveur à partir du prix de l'offre au moment de la déclaration (jamais saisi par le client).
CREATE TABLE subscription_payments (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  public_id      CHAR(36)     NOT NULL,
  company_id     BIGINT UNSIGNED NOT NULL,
  plan_id        BIGINT UNSIGNED NOT NULL,
  period         ENUM('monthly','yearly') NOT NULL,
  amount         DECIMAL(15,3) NOT NULL,
  currency       CHAR(3)      NOT NULL,
  reference      VARCHAR(60)  NOT NULL COMMENT 'référence / numéro du virement indiqué par le client',
  paid_on        DATE         NOT NULL,
  note           VARCHAR(500) NULL,
  status         ENUM('pending','confirmed','rejected') NOT NULL DEFAULT 'pending',
  received_amount DECIMAL(15,3) NULL COMMENT 'montant constaté par l''administrateur à la confirmation',
  review_note    VARCHAR(500) NULL,
  reviewed_by    BIGINT UNSIGNED NULL,
  reviewed_at    DATETIME     NULL,
  period_end     DATE         NULL COMMENT 'nouvelle échéance appliquée à la confirmation',
  created_by     BIGINT UNSIGNED NULL,
  created_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_subpay_public (public_id),
  KEY idx_subpay_company (company_id, id),
  KEY idx_subpay_status (status, id),
  CONSTRAINT fk_subpay_company FOREIGN KEY (company_id) REFERENCES companies (id),
  CONSTRAINT fk_subpay_plan FOREIGN KEY (plan_id) REFERENCES subscription_plans (id),
  CONSTRAINT fk_subpay_reviewer FOREIGN KEY (reviewed_by) REFERENCES users (id),
  CONSTRAINT fk_subpay_creator FOREIGN KEY (created_by) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 3) Rappel de fin d'essai : envoyé une seule fois (le marqueur est posé AVANT l'envoi, ce qui évite les doublons même avec deux instances).
ALTER TABLE company_subscriptions
  ADD COLUMN trial_reminder_sent_at DATETIME NULL AFTER trial_ends_at;
