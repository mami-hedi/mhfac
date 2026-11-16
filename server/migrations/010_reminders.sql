-- Relances clients : journal de chaque relance envoyée (ou échouée) pour les factures en retard.
CREATE TABLE payment_reminders (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  company_id  BIGINT UNSIGNED NOT NULL,
  client_id   BIGINT UNSIGNED NOT NULL,
  recipients  VARCHAR(500) NOT NULL,
  subject     VARCHAR(200) NOT NULL,
  invoice_numbers VARCHAR(1000) NOT NULL,
  total_due   DECIMAL(15,3) NOT NULL,
  currency    CHAR(3) NOT NULL,
  status      ENUM('sent','failed') NOT NULL,
  error       VARCHAR(250) NULL,
  sent_by     BIGINT UNSIGNED NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_reminders_client (company_id, client_id, created_at),
  CONSTRAINT fk_reminders_company FOREIGN KEY (company_id) REFERENCES companies (id),
  CONSTRAINT fk_reminders_client FOREIGN KEY (client_id) REFERENCES clients (id),
  CONSTRAINT fk_reminders_user FOREIGN KEY (sent_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
