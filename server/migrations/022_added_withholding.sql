-- Retenue à la source ajoutée APRÈS l'émission d'une facture (oubli au départ).
-- La facture émise n'est JAMAIS modifiée : la retenue est un événement côté règlement
-- (règlement de mode 'withholding' affecté à la facture, donc déduit du reste à payer, annulable avec motif)
-- + une fiche document_withholdings qui porte le taux, la base et le montant calculés côté serveur.
ALTER TABLE payments MODIFY method ENUM('cash','bank_transfer','cheque','card','bill_of_exchange','other','withholding') NOT NULL;
ALTER TABLE supplier_payments MODIFY method ENUM('cash','bank_transfer','cheque','card','bill_of_exchange','other','withholding') NOT NULL;

CREATE TABLE document_withholdings (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  company_id         BIGINT UNSIGNED NOT NULL,
  direction          ENUM('sales','purchase') NOT NULL,
  invoice_id         BIGINT UNSIGNED NOT NULL COMMENT 'invoices.id (sales) ou purchase_invoices.id (purchase)',
  payment_id         BIGINT UNSIGNED NOT NULL COMMENT 'payments.id (sales) ou supplier_payments.id (purchase)',
  rate               DECIMAL(5,2) NOT NULL,
  base_amount        DECIMAL(15,3) NOT NULL COMMENT 'TTC hors timbre au moment de l''enregistrement',
  amount             DECIMAL(15,3) NOT NULL,
  withholding_date   DATE NOT NULL,
  certificate_number VARCHAR(60) NULL,
  notes              VARCHAR(500) NULL,
  created_by         BIGINT UNSIGNED NULL,
  created_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_dw_payment (direction, payment_id),
  KEY idx_dw_invoice (company_id, direction, invoice_id),
  CONSTRAINT fk_dw_company FOREIGN KEY (company_id) REFERENCES companies (id),
  CONSTRAINT fk_dw_user FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
