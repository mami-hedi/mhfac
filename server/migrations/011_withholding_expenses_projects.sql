-- 011 : retenue à la source (suivi des attestations), notes de débours, projets.

-- Suivi des attestations de retenue à la source : une ligne par facture concernée (montant lu sur la facture, jamais recopié).
-- direction 'sales'  : retenue subie sur nos factures de vente  -> attestation à recevoir du client.
-- direction 'purchase': retenue que nous opérons sur une facture d'achat -> attestation à délivrer au fournisseur.
CREATE TABLE withholding_certificates (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  company_id  BIGINT UNSIGNED NOT NULL,
  direction   ENUM('sales','purchase') NOT NULL,
  invoice_id  BIGINT UNSIGNED NOT NULL COMMENT 'invoices.id (sales) ou purchase_invoices.id (purchase)',
  status      ENUM('pending','done') NOT NULL DEFAULT 'pending',
  certificate_number VARCHAR(60) NULL,
  certificate_date   DATE NULL,
  notes       VARCHAR(500) NULL,
  updated_by  BIGINT UNSIGNED NULL,
  updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_wc_invoice (company_id, direction, invoice_id),
  CONSTRAINT fk_wc_company FOREIGN KEY (company_id) REFERENCES companies (id),
  CONSTRAINT fk_wc_user FOREIGN KEY (updated_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Projets
CREATE TABLE projects (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  public_id   CHAR(36) NOT NULL,
  company_id  BIGINT UNSIGNED NOT NULL,
  code        VARCHAR(40) NOT NULL,
  name        VARCHAR(160) NOT NULL,
  client_id   BIGINT UNSIGNED NULL,
  status      ENUM('active','on_hold','completed','cancelled') NOT NULL DEFAULT 'active',
  start_date  DATE NULL,
  end_date    DATE NULL,
  budget      DECIMAL(15,3) NULL COMMENT 'budget de dépenses prévu (TND)',
  description TEXT NULL,
  created_by  BIGINT UNSIGNED NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_projects_public (public_id),
  UNIQUE KEY uq_projects_code (company_id, code),
  CONSTRAINT fk_projects_company FOREIGN KEY (company_id) REFERENCES companies (id),
  CONSTRAINT fk_projects_client FOREIGN KEY (client_id) REFERENCES clients (id),
  CONSTRAINT fk_projects_user FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Notes de débours : sommes avancées pour le compte d'un client (ventes) ou reçues d'un tiers (achats), refacturées/reportées à l'identique, hors TVA.
CREATE TABLE expense_notes (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  public_id   CHAR(36) NOT NULL,
  company_id  BIGINT UNSIGNED NOT NULL,
  kind        ENUM('sales','purchase') NOT NULL,
  number      VARCHAR(40) NULL,
  status      ENUM('draft','validated','cancelled') NOT NULL DEFAULT 'draft',
  client_id   BIGINT UNSIGNED NULL,
  supplier_id BIGINT UNSIGNED NULL,
  party_snapshot JSON NOT NULL,
  note_date   DATE NOT NULL,
  currency    CHAR(3) NOT NULL DEFAULT 'TND',
  exchange_rate DECIMAL(15,6) NOT NULL DEFAULT 1,
  total       DECIMAL(15,3) NOT NULL DEFAULT 0,
  project_id  BIGINT UNSIGNED NULL,
  notes       TEXT NULL,
  cancel_reason VARCHAR(255) NULL,
  created_by  BIGINT UNSIGNED NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_en_public (public_id),
  UNIQUE KEY uq_en_number (company_id, kind, number),
  KEY idx_en_list (company_id, kind, status, note_date),
  CONSTRAINT fk_en_company FOREIGN KEY (company_id) REFERENCES companies (id),
  CONSTRAINT fk_en_client FOREIGN KEY (client_id) REFERENCES clients (id),
  CONSTRAINT fk_en_supplier FOREIGN KEY (supplier_id) REFERENCES suppliers (id),
  CONSTRAINT fk_en_project FOREIGN KEY (project_id) REFERENCES projects (id),
  CONSTRAINT fk_en_user FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE expense_note_lines (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  expense_note_id BIGINT UNSIGNED NOT NULL,
  position    SMALLINT UNSIGNED NOT NULL,
  description VARCHAR(255) NOT NULL,
  payee       VARCHAR(160) NULL COMMENT 'tiers payé (ex. greffe, douane, transporteur)',
  proof_ref   VARCHAR(80) NULL COMMENT 'n° du justificatif (quittance, reçu)',
  amount      DECIMAL(15,3) NOT NULL,
  PRIMARY KEY (id),
  KEY idx_enl_parent (expense_note_id),
  CONSTRAINT fk_enl_parent FOREIGN KEY (expense_note_id) REFERENCES expense_notes (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Rattachement des documents à un projet (métadonnée, sans effet sur les montants)
ALTER TABLE quotes ADD COLUMN project_id BIGINT UNSIGNED NULL;
ALTER TABLE quotes ADD CONSTRAINT fk_quotes_project FOREIGN KEY (project_id) REFERENCES projects (id);
ALTER TABLE sales_orders ADD COLUMN project_id BIGINT UNSIGNED NULL;
ALTER TABLE sales_orders ADD CONSTRAINT fk_so_project FOREIGN KEY (project_id) REFERENCES projects (id);
ALTER TABLE invoices ADD COLUMN project_id BIGINT UNSIGNED NULL;
ALTER TABLE invoices ADD CONSTRAINT fk_invoices_project FOREIGN KEY (project_id) REFERENCES projects (id);
ALTER TABLE purchase_orders ADD COLUMN project_id BIGINT UNSIGNED NULL;
ALTER TABLE purchase_orders ADD CONSTRAINT fk_po_project FOREIGN KEY (project_id) REFERENCES projects (id);
ALTER TABLE purchase_invoices ADD COLUMN project_id BIGINT UNSIGNED NULL;
ALTER TABLE purchase_invoices ADD CONSTRAINT fk_pi_project FOREIGN KEY (project_id) REFERENCES projects (id);
