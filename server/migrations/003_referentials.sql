-- 003 : referentiels (Phase 5) : sequences, taux de TVA, categories, clients, fournisseurs, articles
-- Montants : DECIMAL(15,3). Aucun taux fiscal n'est insere : ils sont parametres par entreprise.

CREATE TABLE document_sequences (
  company_id  BIGINT UNSIGNED NOT NULL,
  doc_type    VARCHAR(40) NOT NULL,
  series      VARCHAR(20) NOT NULL DEFAULT '',
  last_number BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'dernier numero attribue',
  PRIMARY KEY (company_id, doc_type, series),
  CONSTRAINT fk_seq_company FOREIGN KEY (company_id) REFERENCES companies (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE tax_rates (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  public_id  CHAR(36)     NOT NULL,
  company_id BIGINT UNSIGNED NOT NULL,
  name       VARCHAR(60)  NOT NULL,
  rate       DECIMAL(5,2) NOT NULL,
  kind       ENUM('standard','exempt','suspended') NOT NULL DEFAULT 'standard' COMMENT 'exempt/suspended : taux 0 impose',
  is_default TINYINT(1)   NOT NULL DEFAULT 0,
  is_active  TINYINT(1)   NOT NULL DEFAULT 1,
  notes      VARCHAR(255) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_tax_public (public_id),
  UNIQUE KEY uq_tax_name (company_id, name),
  CONSTRAINT fk_tax_company FOREIGN KEY (company_id) REFERENCES companies (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE product_categories (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  public_id  CHAR(36)     NOT NULL,
  company_id BIGINT UNSIGNED NOT NULL,
  name       VARCHAR(100) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_cat_public (public_id),
  UNIQUE KEY uq_cat_name (company_id, name),
  CONSTRAINT fk_cat_company FOREIGN KEY (company_id) REFERENCES companies (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE clients (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  public_id          CHAR(36)     NOT NULL,
  company_id         BIGINT UNSIGNED NOT NULL,
  code               VARCHAR(30)  NOT NULL,
  name               VARCHAR(190) NOT NULL,
  type               ENUM('individual','company') NOT NULL DEFAULT 'company',
  tax_id             VARCHAR(50)  NULL COMMENT 'Matricule fiscal',
  trade_register     VARCHAR(60)  NULL,
  address            VARCHAR(255) NULL,
  governorate        VARCHAR(100) NULL,
  postal_code        VARCHAR(20)  NULL,
  phone              VARCHAR(40)  NULL,
  email              VARCHAR(190) NULL,
  country            CHAR(2)      NOT NULL DEFAULT 'TN',
  currency           CHAR(3)      NOT NULL DEFAULT 'TND',
  payment_terms_days SMALLINT UNSIGNED NOT NULL DEFAULT 0 COMMENT '0 = au comptant',
  notes              TEXT NULL,
  status             ENUM('active','archived') NOT NULL DEFAULT 'active',
  created_by         BIGINT UNSIGNED NULL,
  created_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_clients_public (public_id),
  UNIQUE KEY uq_clients_code (company_id, code),
  KEY idx_clients_name (company_id, name),
  KEY idx_clients_status (company_id, status),
  KEY idx_clients_taxid (company_id, tax_id),
  CONSTRAINT fk_clients_company FOREIGN KEY (company_id) REFERENCES companies (id),
  CONSTRAINT fk_clients_user FOREIGN KEY (created_by) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE suppliers (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  public_id          CHAR(36)     NOT NULL,
  company_id         BIGINT UNSIGNED NOT NULL,
  code               VARCHAR(30)  NOT NULL,
  name               VARCHAR(190) NOT NULL,
  type               ENUM('individual','company') NOT NULL DEFAULT 'company',
  tax_id             VARCHAR(50)  NULL,
  trade_register     VARCHAR(60)  NULL,
  address            VARCHAR(255) NULL,
  governorate        VARCHAR(100) NULL,
  postal_code        VARCHAR(20)  NULL,
  phone              VARCHAR(40)  NULL,
  email              VARCHAR(190) NULL,
  country            CHAR(2)      NOT NULL DEFAULT 'TN',
  currency           CHAR(3)      NOT NULL DEFAULT 'TND',
  payment_terms_days SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  notes              TEXT NULL,
  status             ENUM('active','archived') NOT NULL DEFAULT 'active',
  created_by         BIGINT UNSIGNED NULL,
  created_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_suppliers_public (public_id),
  UNIQUE KEY uq_suppliers_code (company_id, code),
  KEY idx_suppliers_name (company_id, name),
  KEY idx_suppliers_status (company_id, status),
  KEY idx_suppliers_taxid (company_id, tax_id),
  CONSTRAINT fk_suppliers_company FOREIGN KEY (company_id) REFERENCES companies (id),
  CONSTRAINT fk_suppliers_user FOREIGN KEY (created_by) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE products (
  id                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  public_id            CHAR(36)     NOT NULL,
  company_id           BIGINT UNSIGNED NOT NULL,
  sku                  VARCHAR(60)  NOT NULL,
  barcode              VARCHAR(60)  NULL,
  name                 VARCHAR(190) NOT NULL,
  description          TEXT NULL,
  type                 ENUM('product','service') NOT NULL DEFAULT 'product',
  category_id          BIGINT UNSIGNED NULL,
  sale_price           DECIMAL(15,3) NOT NULL DEFAULT 0 COMMENT 'Prix de vente HT',
  purchase_price       DECIMAL(15,3) NULL COMMENT 'Prix d''achat indicatif HT',
  unit                 VARCHAR(20)  NOT NULL DEFAULT 'unité',
  tax_rate_id          BIGINT UNSIGNED NULL,
  track_stock          TINYINT(1)   NOT NULL DEFAULT 0,
  stock_alert_threshold DECIMAL(15,4) NULL,
  status               ENUM('active','archived') NOT NULL DEFAULT 'active',
  created_by           BIGINT UNSIGNED NULL,
  created_at           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_products_public (public_id),
  UNIQUE KEY uq_products_sku (company_id, sku),
  KEY idx_products_name (company_id, name),
  KEY idx_products_barcode (company_id, barcode),
  KEY idx_products_status (company_id, status),
  KEY idx_products_category (category_id),
  CONSTRAINT fk_products_company FOREIGN KEY (company_id) REFERENCES companies (id),
  CONSTRAINT fk_products_category FOREIGN KEY (category_id) REFERENCES product_categories (id),
  CONSTRAINT fk_products_tax FOREIGN KEY (tax_rate_id) REFERENCES tax_rates (id),
  CONSTRAINT fk_products_user FOREIGN KEY (created_by) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Entreprises deja existantes : memes taux proposes (modifiables) qu'a la creation d'une nouvelle entreprise.
INSERT INTO tax_rates (public_id, company_id, name, rate, kind, is_default, notes)
SELECT UUID(), c.id, t.name, t.rate, t.kind, t.is_default, 'Valeur indicative à valider avec votre comptable'
FROM companies c
JOIN (SELECT 'TVA 19 %' AS name, 19.00 AS rate, 'standard' AS kind, 1 AS is_default
      UNION ALL SELECT 'TVA 13 %', 13.00, 'standard', 0
      UNION ALL SELECT 'TVA 7 %', 7.00, 'standard', 0
      UNION ALL SELECT 'Exonéré (0 %)', 0.00, 'exempt', 0) t
WHERE NOT EXISTS (SELECT 1 FROM tax_rates x WHERE x.company_id = c.id);
