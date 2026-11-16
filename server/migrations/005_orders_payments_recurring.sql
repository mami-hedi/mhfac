-- 005 : commandes client, bons de livraison, acomptes/solde, reglements, factures recurrentes, e-mails (Phase 6 suite)

CREATE TABLE sales_orders (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  public_id          CHAR(36)     NOT NULL,
  company_id         BIGINT UNSIGNED NOT NULL,
  number             VARCHAR(40)  NOT NULL,
  status             ENUM('draft','confirmed','cancelled') NOT NULL DEFAULT 'draft' COMMENT 'livraison / facturation = derivees',
  expected_date      DATE NULL COMMENT 'Date de livraison souhaitee',
  quote_id           BIGINT UNSIGNED NULL,
  cancel_reason      VARCHAR(255) NULL,
  client_id          BIGINT UNSIGNED NOT NULL,
  client_snapshot    JSON NOT NULL,
  company_snapshot   JSON NULL,
  issue_date         DATE NOT NULL,
  currency           CHAR(3)      NOT NULL DEFAULT 'TND',
  exchange_rate      DECIMAL(15,6) NOT NULL DEFAULT 1,
  rate_date          DATE NULL,
  global_discount_pct DECIMAL(5,2) NOT NULL DEFAULT 0,
  subtotal           DECIMAL(15,3) NOT NULL DEFAULT 0,
  line_discount_total DECIMAL(15,3) NOT NULL DEFAULT 0,
  global_discount_amount DECIMAL(15,3) NOT NULL DEFAULT 0,
  total_ht           DECIMAL(15,3) NOT NULL DEFAULT 0,
  total_tax          DECIMAL(15,3) NOT NULL DEFAULT 0,
  total_ttc          DECIMAL(15,3) NOT NULL DEFAULT 0,
  stamp_duty         DECIMAL(15,3) NOT NULL DEFAULT 0,
  withholding_rate   DECIMAL(5,2) NOT NULL DEFAULT 0,
  withholding_amount DECIMAL(15,3) NOT NULL DEFAULT 0,
  net_payable        DECIMAL(15,3) NOT NULL DEFAULT 0,
  payment_terms_days SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  notes              TEXT NULL,
  terms              TEXT NULL,
  created_by         BIGINT UNSIGNED NULL,
  created_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_orders_public (public_id),
  UNIQUE KEY uq_orders_number (company_id, number),
  KEY idx_orders_client (company_id, client_id),
  KEY idx_orders_date (company_id, issue_date),
  CONSTRAINT fk_orders_company FOREIGN KEY (company_id) REFERENCES companies (id),
  CONSTRAINT fk_orders_client FOREIGN KEY (client_id) REFERENCES clients (id),
  CONSTRAINT fk_orders_user FOREIGN KEY (created_by) REFERENCES users (id),
  CONSTRAINT fk_orders_quote FOREIGN KEY (quote_id) REFERENCES quotes (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE sales_order_lines (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  sales_order_id BIGINT UNSIGNED NOT NULL,
  position    SMALLINT UNSIGNED NOT NULL,
  product_id  BIGINT UNSIGNED NULL,
  description VARCHAR(500) NOT NULL,
  quantity    DECIMAL(15,4) NOT NULL,
  unit        VARCHAR(20)  NOT NULL DEFAULT 'unité',
  unit_price  DECIMAL(15,3) NOT NULL,
  discount_pct DECIMAL(5,2) NOT NULL DEFAULT 0,
  tax_rate    DECIMAL(5,2) NOT NULL,
  tax_name    VARCHAR(60)  NULL,
  gross_amount DECIMAL(15,3) NOT NULL,
  discount_amount DECIMAL(15,3) NOT NULL,
  net_amount  DECIMAL(15,3) NOT NULL,
  PRIMARY KEY (id),
  KEY idx_order_lines_parent (sales_order_id, position),
  CONSTRAINT fk_order_lines_parent FOREIGN KEY (sales_order_id) REFERENCES sales_orders (id) ON DELETE CASCADE,
  CONSTRAINT fk_order_lines_product FOREIGN KEY (product_id) REFERENCES products (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE sales_order_tax_lines (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  sales_order_id BIGINT UNSIGNED NOT NULL,
  tax_rate    DECIMAL(5,2) NOT NULL,
  base        DECIMAL(15,3) NOT NULL,
  amount      DECIMAL(15,3) NOT NULL,
  PRIMARY KEY (id),
  KEY idx_order_tax_parent (sales_order_id),
  CONSTRAINT fk_order_tax_parent FOREIGN KEY (sales_order_id) REFERENCES sales_orders (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE quotes ADD COLUMN converted_order_id BIGINT UNSIGNED NULL AFTER converted_invoice_id,
  ADD CONSTRAINT fk_quotes_order FOREIGN KEY (converted_order_id) REFERENCES sales_orders (id);

CREATE TABLE delivery_notes (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  public_id      CHAR(36) NOT NULL,
  company_id     BIGINT UNSIGNED NOT NULL,
  number         VARCHAR(40) NULL COMMENT 'attribue a la validation',
  series         VARCHAR(20) NULL,
  status         ENUM('draft','validated','cancelled') NOT NULL DEFAULT 'draft',
  order_id       BIGINT UNSIGNED NOT NULL,
  client_id      BIGINT UNSIGNED NOT NULL,
  client_snapshot JSON NOT NULL,
  company_snapshot JSON NULL,
  delivery_date  DATE NOT NULL,
  delivery_address VARCHAR(500) NULL,
  notes          TEXT NULL,
  cancel_reason  VARCHAR(255) NULL,
  validated_at   TIMESTAMP NULL,
  validated_by   BIGINT UNSIGNED NULL,
  created_by     BIGINT UNSIGNED NULL,
  created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_delivery_public (public_id),
  UNIQUE KEY uq_delivery_number (company_id, number),
  KEY idx_delivery_order (order_id),
  KEY idx_delivery_client (company_id, client_id),
  CONSTRAINT fk_delivery_company FOREIGN KEY (company_id) REFERENCES companies (id),
  CONSTRAINT fk_delivery_order FOREIGN KEY (order_id) REFERENCES sales_orders (id),
  CONSTRAINT fk_delivery_client FOREIGN KEY (client_id) REFERENCES clients (id),
  CONSTRAINT fk_delivery_user FOREIGN KEY (created_by) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE delivery_note_lines (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  delivery_note_id BIGINT UNSIGNED NOT NULL,
  order_line_id    BIGINT UNSIGNED NOT NULL,
  position         SMALLINT UNSIGNED NOT NULL,
  description      VARCHAR(500) NOT NULL,
  quantity         DECIMAL(15,4) NOT NULL,
  unit             VARCHAR(20) NOT NULL DEFAULT 'unité',
  PRIMARY KEY (id),
  KEY idx_dn_lines_parent (delivery_note_id, position),
  KEY idx_dn_lines_order_line (order_line_id),
  CONSTRAINT fk_dn_lines_parent FOREIGN KEY (delivery_note_id) REFERENCES delivery_notes (id) ON DELETE CASCADE,
  CONSTRAINT fk_dn_lines_order_line FOREIGN KEY (order_line_id) REFERENCES sales_order_lines (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Factures : type (standard / acompte / solde), liens commande, livraison, recurrence
CREATE TABLE recurring_invoices (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  public_id     CHAR(36) NOT NULL,
  company_id    BIGINT UNSIGNED NOT NULL,
  client_id     BIGINT UNSIGNED NOT NULL,
  name          VARCHAR(120) NOT NULL,
  frequency     ENUM('weekly','monthly','quarterly','yearly') NOT NULL DEFAULT 'monthly',
  start_date    DATE NOT NULL,
  next_run_date DATE NULL COMMENT 'NULL quand la serie est terminee',
  end_date      DATE NULL,
  status        ENUM('active','paused','ended') NOT NULL DEFAULT 'active',
  template      JSON NOT NULL COMMENT 'Lignes et conditions de la facture a generer (validees comme une facture)',
  run_count     INT UNSIGNED NOT NULL DEFAULT 0,
  last_run_at   TIMESTAMP NULL,
  created_by    BIGINT UNSIGNED NULL,
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_recurring_public (public_id),
  KEY idx_recurring_due (status, next_run_date),
  KEY idx_recurring_company (company_id),
  CONSTRAINT fk_recurring_company FOREIGN KEY (company_id) REFERENCES companies (id),
  CONSTRAINT fk_recurring_client FOREIGN KEY (client_id) REFERENCES clients (id),
  CONSTRAINT fk_recurring_user FOREIGN KEY (created_by) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE invoices
  ADD COLUMN invoice_type ENUM('standard','deposit','final') NOT NULL DEFAULT 'standard' AFTER kind,
  ADD COLUMN order_id BIGINT UNSIGNED NULL AFTER quote_id,
  ADD COLUMN delivery_note_id BIGINT UNSIGNED NULL AFTER order_id,
  ADD COLUMN recurring_id BIGINT UNSIGNED NULL AFTER delivery_note_id,
  ADD COLUMN deposit_pct DECIMAL(5,2) NULL COMMENT 'Pourcentage de la commande (facture d''acompte)',
  ADD COLUMN deposit_deducted DECIMAL(15,3) NOT NULL DEFAULT 0 COMMENT 'Acomptes TTC deduits (facture de solde), fige a l''emission',
  ADD KEY idx_invoices_order (order_id),
  ADD UNIQUE KEY uq_invoices_delivery (delivery_note_id),
  ADD CONSTRAINT fk_invoices_order FOREIGN KEY (order_id) REFERENCES sales_orders (id),
  ADD CONSTRAINT fk_invoices_delivery FOREIGN KEY (delivery_note_id) REFERENCES delivery_notes (id),
  ADD CONSTRAINT fk_invoices_recurring FOREIGN KEY (recurring_id) REFERENCES recurring_invoices (id);

CREATE TABLE invoice_deposits (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  invoice_id         BIGINT UNSIGNED NOT NULL COMMENT 'Facture de solde',
  deposit_invoice_id BIGINT UNSIGNED NOT NULL,
  amount             DECIMAL(15,3) NOT NULL COMMENT 'TTC de l''acompte',
  PRIMARY KEY (id),
  UNIQUE KEY uq_deposit_once (deposit_invoice_id),
  KEY idx_invoice_deposits (invoice_id),
  CONSTRAINT fk_idep_invoice FOREIGN KEY (invoice_id) REFERENCES invoices (id),
  CONSTRAINT fk_idep_deposit FOREIGN KEY (deposit_invoice_id) REFERENCES invoices (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE recurring_runs (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  recurring_id BIGINT UNSIGNED NOT NULL,
  period_date  DATE NOT NULL,
  invoice_id   BIGINT UNSIGNED NOT NULL,
  created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_recurring_period (recurring_id, period_date),
  CONSTRAINT fk_rruns_recurring FOREIGN KEY (recurring_id) REFERENCES recurring_invoices (id),
  CONSTRAINT fk_rruns_invoice FOREIGN KEY (invoice_id) REFERENCES invoices (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Reglements : un reglement est integralement affecte a une ou plusieurs factures du meme client ; jamais supprime, seulement annule.
CREATE TABLE payments (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  public_id     CHAR(36) NOT NULL,
  company_id    BIGINT UNSIGNED NOT NULL,
  number        VARCHAR(40) NOT NULL,
  client_id     BIGINT UNSIGNED NOT NULL,
  payment_date  DATE NOT NULL,
  method        ENUM('cash','bank_transfer','cheque','card','bill_of_exchange','other') NOT NULL,
  currency      CHAR(3) NOT NULL DEFAULT 'TND',
  amount        DECIMAL(15,3) NOT NULL,
  reference     VARCHAR(120) NULL COMMENT 'N° de cheque / virement',
  notes         VARCHAR(500) NULL,
  status        ENUM('recorded','cancelled') NOT NULL DEFAULT 'recorded',
  cancel_reason VARCHAR(255) NULL,
  cancelled_at  TIMESTAMP NULL,
  created_by    BIGINT UNSIGNED NULL,
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_payments_public (public_id),
  UNIQUE KEY uq_payments_number (company_id, number),
  KEY idx_payments_client (company_id, client_id),
  KEY idx_payments_date (company_id, payment_date),
  CONSTRAINT fk_payments_company FOREIGN KEY (company_id) REFERENCES companies (id),
  CONSTRAINT fk_payments_client FOREIGN KEY (client_id) REFERENCES clients (id),
  CONSTRAINT fk_payments_user FOREIGN KEY (created_by) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE payment_allocations (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  payment_id  BIGINT UNSIGNED NOT NULL,
  invoice_id  BIGINT UNSIGNED NOT NULL,
  amount      DECIMAL(15,3) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_alloc (payment_id, invoice_id),
  KEY idx_alloc_invoice (invoice_id),
  CONSTRAINT fk_alloc_payment FOREIGN KEY (payment_id) REFERENCES payments (id),
  CONSTRAINT fk_alloc_invoice FOREIGN KEY (invoice_id) REFERENCES invoices (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Journal des e-mails de documents envoyes
CREATE TABLE document_emails (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  company_id   BIGINT UNSIGNED NOT NULL,
  doc_type     ENUM('quote','invoice','credit_note','sales_order','delivery_note') NOT NULL,
  doc_public_id CHAR(36) NOT NULL,
  doc_number   VARCHAR(40) NULL,
  recipients   VARCHAR(500) NOT NULL,
  subject      VARCHAR(200) NOT NULL,
  status       ENUM('sent','failed') NOT NULL,
  error        VARCHAR(255) NULL,
  sent_by      BIGINT UNSIGNED NULL,
  created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_docmail_doc (company_id, doc_type, doc_public_id),
  KEY idx_docmail_rate (company_id, created_at),
  CONSTRAINT fk_docmail_company FOREIGN KEY (company_id) REFERENCES companies (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
