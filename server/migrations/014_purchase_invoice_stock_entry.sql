-- Entrée en stock directe depuis une facture d'achat (sans commande ni réception).
ALTER TABLE purchase_invoices
  ADD COLUMN stock_entry TINYINT(1) NOT NULL DEFAULT 0 COMMENT '1 = à l''enregistrement, les articles suivis entrent en stock',
  ADD COLUMN stock_warehouse_id BIGINT UNSIGNED NULL,
  ADD CONSTRAINT fk_pi_stock_wh FOREIGN KEY (stock_warehouse_id) REFERENCES warehouses (id);
