-- Logistique des factures directes (sans commande) :
--  1) facture de vente : option « sortir les articles du stock à l'émission » (miroir de l'entrée en stock des factures d'achat) ;
--  2) bon de livraison (BL) et bon de réception (BR) générés DEPUIS une facture : order_id devient facultatif, lien source_invoice_id.
-- stock_impact = 0 : le BL ne sort rien du stock car la facture l'a déjà fait (jamais deux sorties pour la même marchandise).

ALTER TABLE invoices
  ADD COLUMN stock_exit TINYINT(1) NOT NULL DEFAULT 0 COMMENT '1 = à l''émission, les articles suivis sortent du stock',
  ADD COLUMN stock_warehouse_id BIGINT UNSIGNED NULL,
  ADD CONSTRAINT fk_inv_stock_wh FOREIGN KEY (stock_warehouse_id) REFERENCES warehouses (id);

ALTER TABLE delivery_notes
  MODIFY order_id BIGINT UNSIGNED NULL,
  ADD COLUMN source_invoice_id BIGINT UNSIGNED NULL COMMENT 'facture de vente dont ce bon est issu',
  ADD COLUMN stock_impact TINYINT(1) NOT NULL DEFAULT 1 COMMENT '0 = la facture source a déjà sorti le stock',
  ADD KEY idx_dn_source_invoice (source_invoice_id),
  ADD CONSTRAINT fk_dn_source_invoice FOREIGN KEY (source_invoice_id) REFERENCES invoices (id);

ALTER TABLE delivery_note_lines
  MODIFY order_line_id BIGINT UNSIGNED NULL,
  ADD COLUMN invoice_line_id BIGINT UNSIGNED NULL,
  ADD COLUMN product_id BIGINT UNSIGNED NULL,
  ADD CONSTRAINT fk_dn_lines_inv_line FOREIGN KEY (invoice_line_id) REFERENCES invoice_lines (id),
  ADD CONSTRAINT fk_dn_lines_product FOREIGN KEY (product_id) REFERENCES products (id);
UPDATE delivery_note_lines dl JOIN sales_order_lines ol ON ol.id = dl.order_line_id SET dl.product_id = ol.product_id;

ALTER TABLE purchase_receipts
  MODIFY order_id BIGINT UNSIGNED NULL,
  ADD COLUMN source_invoice_id BIGINT UNSIGNED NULL COMMENT 'facture d''achat dont cette réception est issue',
  ADD KEY idx_pr_source_invoice (source_invoice_id),
  ADD CONSTRAINT fk_pr_source_invoice FOREIGN KEY (source_invoice_id) REFERENCES purchase_invoices (id);

ALTER TABLE purchase_receipt_lines
  MODIFY order_line_id BIGINT UNSIGNED NULL,
  ADD COLUMN invoice_line_id BIGINT UNSIGNED NULL,
  ADD COLUMN product_id BIGINT UNSIGNED NULL,
  ADD CONSTRAINT fk_prl_inv_line FOREIGN KEY (invoice_line_id) REFERENCES purchase_invoice_lines (id),
  ADD CONSTRAINT fk_prl_product FOREIGN KEY (product_id) REFERENCES products (id);
UPDATE purchase_receipt_lines rl JOIN purchase_order_lines ol ON ol.id = rl.order_line_id SET rl.product_id = ol.product_id;
