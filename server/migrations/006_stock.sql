-- 006 : stock (Phase 7A) - entrepots, mouvements immuables, valorisation au cout moyen pondere, bons, inventaires

CREATE TABLE warehouses (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  public_id   CHAR(36)     NOT NULL,
  company_id  BIGINT UNSIGNED NOT NULL,
  code        VARCHAR(20)  NOT NULL,
  name        VARCHAR(120) NOT NULL,
  address     VARCHAR(255) NULL,
  is_default  TINYINT(1)   NOT NULL DEFAULT 0,
  status      ENUM('active','archived') NOT NULL DEFAULT 'active',
  created_by  BIGINT UNSIGNED NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_warehouses_public (public_id),
  UNIQUE KEY uq_warehouses_code (company_id, code),
  CONSTRAINT fk_warehouses_company FOREIGN KEY (company_id) REFERENCES companies (id),
  CONSTRAINT fk_warehouses_user FOREIGN KEY (created_by) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Une ligne par article suivi : quantite totale et cout moyen pondere (CMUP). Verrou de ligne = serialisation des mouvements d'un article.
CREATE TABLE product_stock (
  product_id  BIGINT UNSIGNED NOT NULL,
  company_id  BIGINT UNSIGNED NOT NULL,
  quantity    DECIMAL(15,4) NOT NULL DEFAULT 0,
  avg_cost    DECIMAL(15,4) NOT NULL DEFAULT 0 COMMENT 'cout unitaire moyen pondere HT',
  updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (product_id),
  KEY idx_product_stock_company (company_id),
  CONSTRAINT fk_pstock_product FOREIGN KEY (product_id) REFERENCES products (id),
  CONSTRAINT fk_pstock_company FOREIGN KEY (company_id) REFERENCES companies (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE stock_levels (
  product_id   BIGINT UNSIGNED NOT NULL,
  warehouse_id BIGINT UNSIGNED NOT NULL,
  company_id   BIGINT UNSIGNED NOT NULL,
  quantity     DECIMAL(15,4) NOT NULL DEFAULT 0,
  PRIMARY KEY (product_id, warehouse_id),
  KEY idx_levels_warehouse (warehouse_id),
  KEY idx_levels_company (company_id),
  CONSTRAINT fk_levels_product FOREIGN KEY (product_id) REFERENCES products (id),
  CONSTRAINT fk_levels_warehouse FOREIGN KEY (warehouse_id) REFERENCES warehouses (id),
  CONSTRAINT fk_levels_company FOREIGN KEY (company_id) REFERENCES companies (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Journal des mouvements : jamais modifie ni supprime ; une erreur se corrige par un mouvement inverse.
-- L'unicite (source, ligne, nature) rend chaque operation idempotente : rejouer une validation ne cree pas un 2e mouvement.
CREATE TABLE stock_movements (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  public_id       CHAR(36) NOT NULL,
  company_id      BIGINT UNSIGNED NOT NULL,
  product_id      BIGINT UNSIGNED NOT NULL,
  warehouse_id    BIGINT UNSIGNED NOT NULL,
  kind            ENUM('entry','withdrawal','transfer_in','transfer_out','adjustment','inventory','delivery','delivery_reversal','cancellation') NOT NULL,
  quantity        DECIMAL(15,4) NOT NULL COMMENT 'signe : + entree, - sortie',
  unit_cost       DECIMAL(15,4) NOT NULL,
  total_cost      DECIMAL(15,3) NOT NULL COMMENT 'signe, = quantite x cout unitaire',
  balance_after   DECIMAL(15,4) NOT NULL COMMENT 'stock de l''entrepot apres le mouvement',
  avg_cost_after  DECIMAL(15,4) NOT NULL,
  movement_date   DATE NOT NULL,
  reason          VARCHAR(255) NULL,
  source_type     VARCHAR(30) NOT NULL,
  source_id       CHAR(36) NULL,
  source_number   VARCHAR(40) NULL,
  source_line_id  BIGINT UNSIGNED NULL,
  created_by      BIGINT UNSIGNED NULL,
  created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_movements_public (public_id),
  UNIQUE KEY uq_movements_source (company_id, source_type, source_id, source_line_id, kind),
  KEY idx_movements_product (company_id, product_id, movement_date),
  KEY idx_movements_warehouse (warehouse_id),
  KEY idx_movements_date (company_id, movement_date),
  CONSTRAINT fk_movements_company FOREIGN KEY (company_id) REFERENCES companies (id),
  CONSTRAINT fk_movements_product FOREIGN KEY (product_id) REFERENCES products (id),
  CONSTRAINT fk_movements_warehouse FOREIGN KEY (warehouse_id) REFERENCES warehouses (id),
  CONSTRAINT fk_movements_user FOREIGN KEY (created_by) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Bons d'entree, de prelevement (sortie) et de transfert
CREATE TABLE stock_vouchers (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  public_id       CHAR(36) NOT NULL,
  company_id      BIGINT UNSIGNED NOT NULL,
  type            ENUM('entry','withdrawal','transfer') NOT NULL,
  number          VARCHAR(40) NULL COMMENT 'attribue a la validation',
  series          VARCHAR(20) NULL,
  status          ENUM('draft','validated','cancelled') NOT NULL DEFAULT 'draft',
  warehouse_id    BIGINT UNSIGNED NOT NULL COMMENT 'entrepot (transfert : origine)',
  to_warehouse_id BIGINT UNSIGNED NULL COMMENT 'transfert : destination',
  voucher_date    DATE NOT NULL,
  reason          VARCHAR(255) NULL,
  notes           TEXT NULL,
  cancel_reason   VARCHAR(255) NULL,
  validated_at    TIMESTAMP NULL,
  validated_by    BIGINT UNSIGNED NULL,
  created_by      BIGINT UNSIGNED NULL,
  created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_vouchers_public (public_id),
  UNIQUE KEY uq_vouchers_number (company_id, number),
  KEY idx_vouchers_type (company_id, type, voucher_date),
  CONSTRAINT fk_vouchers_company FOREIGN KEY (company_id) REFERENCES companies (id),
  CONSTRAINT fk_vouchers_wh FOREIGN KEY (warehouse_id) REFERENCES warehouses (id),
  CONSTRAINT fk_vouchers_wh2 FOREIGN KEY (to_warehouse_id) REFERENCES warehouses (id),
  CONSTRAINT fk_vouchers_user FOREIGN KEY (created_by) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE stock_voucher_lines (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  voucher_id  BIGINT UNSIGNED NOT NULL,
  position    SMALLINT UNSIGNED NOT NULL,
  product_id  BIGINT UNSIGNED NOT NULL,
  quantity    DECIMAL(15,4) NOT NULL,
  unit_cost   DECIMAL(15,4) NULL COMMENT 'bon d''entree uniquement',
  PRIMARY KEY (id),
  KEY idx_vlines_voucher (voucher_id, position),
  CONSTRAINT fk_vlines_voucher FOREIGN KEY (voucher_id) REFERENCES stock_vouchers (id) ON DELETE CASCADE,
  CONSTRAINT fk_vlines_product FOREIGN KEY (product_id) REFERENCES products (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Fiches d'inventaire : comptage -> validation -> mouvements d'ajustement des ecarts
CREATE TABLE stock_counts (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  public_id     CHAR(36) NOT NULL,
  company_id    BIGINT UNSIGNED NOT NULL,
  number        VARCHAR(40) NULL,
  series        VARCHAR(20) NULL,
  status        ENUM('draft','validated','cancelled') NOT NULL DEFAULT 'draft',
  warehouse_id  BIGINT UNSIGNED NOT NULL,
  count_date    DATE NOT NULL,
  reason        VARCHAR(255) NULL COMMENT 'motif de l''ajustement, obligatoire a la validation',
  notes         TEXT NULL,
  cancel_reason VARCHAR(255) NULL,
  validated_at  TIMESTAMP NULL,
  validated_by  BIGINT UNSIGNED NULL,
  created_by    BIGINT UNSIGNED NULL,
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_counts_public (public_id),
  UNIQUE KEY uq_counts_number (company_id, number),
  KEY idx_counts_company (company_id, count_date),
  CONSTRAINT fk_counts_company FOREIGN KEY (company_id) REFERENCES companies (id),
  CONSTRAINT fk_counts_wh FOREIGN KEY (warehouse_id) REFERENCES warehouses (id),
  CONSTRAINT fk_counts_user FOREIGN KEY (created_by) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE stock_count_lines (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  count_id          BIGINT UNSIGNED NOT NULL,
  product_id        BIGINT UNSIGNED NOT NULL,
  expected_quantity DECIMAL(15,4) NOT NULL COMMENT 'theorique a l''ouverture de la fiche (information)',
  counted_quantity  DECIMAL(15,4) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_count_product (count_id, product_id),
  CONSTRAINT fk_clines_count FOREIGN KEY (count_id) REFERENCES stock_counts (id) ON DELETE CASCADE,
  CONSTRAINT fk_clines_product FOREIGN KEY (product_id) REFERENCES products (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Bon de livraison : entrepot d'ou part la marchandise
ALTER TABLE delivery_notes ADD COLUMN warehouse_id BIGINT UNSIGNED NULL AFTER order_id,
  ADD CONSTRAINT fk_delivery_wh FOREIGN KEY (warehouse_id) REFERENCES warehouses (id);
