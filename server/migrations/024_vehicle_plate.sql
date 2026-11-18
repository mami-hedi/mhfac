-- Matricule du véhicule (livraison, réception, transfert de stock). Une seule modification par commande ALTER (compatibilité TiDB).
ALTER TABLE delivery_notes ADD COLUMN vehicle_plate VARCHAR(20) NULL COMMENT 'matricule du véhicule de livraison';
ALTER TABLE purchase_receipts ADD COLUMN vehicle_plate VARCHAR(20) NULL COMMENT 'matricule du véhicule de livraison reçue';
ALTER TABLE stock_vouchers ADD COLUMN vehicle_plate VARCHAR(20) NULL COMMENT 'transfert : matricule du véhicule';
