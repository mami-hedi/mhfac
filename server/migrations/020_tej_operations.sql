-- Données propres à la déclaration TEJ (retenue à la source opérée sur une facture d'achat).
-- Table séparée : la facture enregistrée n'est jamais modifiée.
CREATE TABLE IF NOT EXISTS withholding_tej_operations (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  company_id    BIGINT UNSIGNED NOT NULL,
  invoice_id    BIGINT UNSIGNED NOT NULL COMMENT 'purchase_invoices.id',
  operation_code VARCHAR(12) NOT NULL COMMENT 'IdTypeOperation TEJ, ex. RS7_000001',
  cnpc          TINYINT(1) NOT NULL DEFAULT 0 COMMENT 'Convention de non double imposition',
  p_charge      TINYINT(1) NOT NULL DEFAULT 0 COMMENT 'Prise en charge de la retenue',
  updated_by    BIGINT UNSIGNED NULL,
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_wto_invoice (company_id, invoice_id),
  CONSTRAINT fk_wto_company FOREIGN KEY (company_id) REFERENCES companies (id),
  CONSTRAINT fk_wto_invoice FOREIGN KEY (invoice_id) REFERENCES purchase_invoices (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
