-- FODEC (Fonds de Développement de la Compétitivité Industrielle) sur les documents de vente.
-- Le FODEC s'ajoute au HT des lignes soumises AVANT la TVA : total_ttc = total_ht + fodec_amount + total_tax.
-- Aucune valeur par défaut fiscale n'est activée : le module est désactivé tant que l'entreprise ne l'active pas (Paramètres).
ALTER TABLE products ADD COLUMN fodec_subject TINYINT(1) NOT NULL DEFAULT 0 COMMENT 'Article soumis au FODEC (liste officielle) : à vérifier par l''entreprise';
ALTER TABLE quote_lines ADD COLUMN fodec TINYINT(1) NOT NULL DEFAULT 0;
ALTER TABLE sales_order_lines ADD COLUMN fodec TINYINT(1) NOT NULL DEFAULT 0;
ALTER TABLE invoice_lines ADD COLUMN fodec TINYINT(1) NOT NULL DEFAULT 0;
ALTER TABLE quotes ADD COLUMN fodec_rate DECIMAL(5,2) NOT NULL DEFAULT 0.00, ADD COLUMN fodec_amount DECIMAL(15,3) NOT NULL DEFAULT 0.000;
ALTER TABLE sales_orders ADD COLUMN fodec_rate DECIMAL(5,2) NOT NULL DEFAULT 0.00, ADD COLUMN fodec_amount DECIMAL(15,3) NOT NULL DEFAULT 0.000;
ALTER TABLE invoices ADD COLUMN fodec_rate DECIMAL(5,2) NOT NULL DEFAULT 0.00, ADD COLUMN fodec_amount DECIMAL(15,3) NOT NULL DEFAULT 0.000;
