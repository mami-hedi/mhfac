-- 012 : couche de facturation électronique (Phase 8B).
-- ATTENTION : seul un adaptateur de SIMULATION est fourni. Aucune connexion à TTN (Tunisie TradeNet) ni à une autre plateforme officielle.
CREATE TABLE einvoice_config (
  company_id  BIGINT UNSIGNED NOT NULL,
  provider    VARCHAR(30) NOT NULL DEFAULT 'simulation',
  scenario    ENUM('accept','reject','network_error') NOT NULL DEFAULT 'accept' COMMENT 'comportement du fournisseur SIMULÉ (tests)',
  updated_by  BIGINT UNSIGNED NULL,
  updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (company_id),
  CONSTRAINT fk_einv_cfg_company FOREIGN KEY (company_id) REFERENCES companies (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE einvoice_transmissions (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  public_id     CHAR(36) NOT NULL,
  company_id    BIGINT UNSIGNED NOT NULL,
  invoice_id    BIGINT UNSIGNED NOT NULL COMMENT 'facture ou avoir de vente émis',
  status        ENUM('preparing','pending','transmitted','accepted','rejected','error','retry') NOT NULL DEFAULT 'preparing',
  provider      VARCHAR(30) NOT NULL,
  mode          ENUM('simulation','production') NOT NULL DEFAULT 'simulation',
  format        VARCHAR(60) NOT NULL,
  idempotency_key CHAR(64) NOT NULL COMMENT 'SHA-256(entreprise, facture, contenu) : un même document ne peut être transmis deux fois',
  payload_hash  CHAR(64) NOT NULL,
  payload       MEDIUMTEXT NOT NULL,
  signature_status ENUM('none','simulated','signed') NOT NULL DEFAULT 'none',
  signature     TEXT NULL,
  provider_reference VARCHAR(120) NULL,
  attempts      SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  last_error    VARCHAR(500) NULL,
  next_retry_at DATETIME NULL,
  transmitted_at DATETIME NULL,
  responded_at  DATETIME NULL,
  response      TEXT NULL,
  created_by    BIGINT UNSIGNED NULL,
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_einv_public (public_id),
  UNIQUE KEY uq_einv_invoice (company_id, invoice_id),
  UNIQUE KEY uq_einv_idem (company_id, idempotency_key),
  KEY idx_einv_status (company_id, status),
  CONSTRAINT fk_einv_company FOREIGN KEY (company_id) REFERENCES companies (id),
  CONSTRAINT fk_einv_invoice FOREIGN KEY (invoice_id) REFERENCES invoices (id),
  CONSTRAINT fk_einv_user FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE einvoice_events (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  transmission_id BIGINT UNSIGNED NOT NULL,
  event           VARCHAR(40) NOT NULL,
  from_status     VARCHAR(20) NULL,
  to_status       VARCHAR(20) NULL,
  detail          TEXT NULL,
  created_by      BIGINT UNSIGNED NULL,
  created_at      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_einv_ev (transmission_id, id),
  CONSTRAINT fk_einv_ev_tx FOREIGN KEY (transmission_id) REFERENCES einvoice_transmissions (id),
  CONSTRAINT fk_einv_ev_user FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
