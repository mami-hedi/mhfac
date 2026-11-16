-- Phase 8C : scan de factures fournisseur (extraction automatique -> brouillon de facture d'achat à relire).
CREATE TABLE purchase_scans (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  public_id          CHAR(36)     NOT NULL,
  company_id         BIGINT UNSIGNED NOT NULL,
  status             ENUM('extracted','converted','discarded') NOT NULL DEFAULT 'extracted',
  file_name          VARCHAR(200) NOT NULL,
  mime_type          VARCHAR(60)  NOT NULL,
  file_size          INT UNSIGNED NOT NULL,
  file_sha256        CHAR(64)     NOT NULL,
  file_data          MEDIUMBLOB   NOT NULL COMMENT 'document original conservé comme pièce justificative',
  extractor          VARCHAR(40)  NOT NULL,
  extraction         JSON         NOT NULL COMMENT 'données lues par l''extracteur, NON validées : relecture humaine obligatoire',
  purchase_invoice_id BIGINT UNSIGNED NULL,
  created_by         BIGINT UNSIGNED NULL,
  created_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_scan_public (public_id),
  UNIQUE KEY uq_scan_hash (company_id, file_sha256),
  KEY idx_scan_company (company_id, status, id),
  CONSTRAINT fk_scan_company FOREIGN KEY (company_id) REFERENCES companies (id),
  CONSTRAINT fk_scan_invoice FOREIGN KEY (purchase_invoice_id) REFERENCES purchase_invoices (id),
  CONSTRAINT fk_scan_user FOREIGN KEY (created_by) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
