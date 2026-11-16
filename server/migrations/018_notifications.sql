-- Notifications dans l'application (cloche). Une ligne par destinataire : le statut lu / non lu est personnel.
-- dedupe_key rend la génération idempotente : rejouer l'analyse ne crée jamais de doublon (UNIQUE entreprise + utilisateur + clé).
CREATE TABLE notifications (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  public_id   CHAR(36)     NOT NULL,
  company_id  BIGINT UNSIGNED NOT NULL,
  user_id     BIGINT UNSIGNED NOT NULL,
  type        VARCHAR(40)  NOT NULL,
  severity    ENUM('info','warning','critical') NOT NULL DEFAULT 'info',
  title       VARCHAR(190) NOT NULL,
  body        VARCHAR(500) NULL,
  link        VARCHAR(255) NULL COMMENT 'route interne du client (jamais une URL externe)',
  dedupe_key  VARCHAR(120) NOT NULL,
  read_at     DATETIME NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_notif_public (public_id),
  UNIQUE KEY uq_notif_dedupe (company_id, user_id, dedupe_key),
  KEY idx_notif_user (company_id, user_id, read_at, created_at),
  CONSTRAINT fk_notif_company FOREIGN KEY (company_id) REFERENCES companies (id),
  CONSTRAINT fk_notif_user FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Préférences : seules les désactivations sont stockées (tout est activé par défaut).
CREATE TABLE notification_preferences (
  company_id  BIGINT UNSIGNED NOT NULL,
  user_id     BIGINT UNSIGNED NOT NULL,
  type        VARCHAR(40)  NOT NULL,
  enabled     TINYINT(1)   NOT NULL DEFAULT 1,
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (company_id, user_id, type),
  CONSTRAINT fk_notifpref_company FOREIGN KEY (company_id) REFERENCES companies (id),
  CONSTRAINT fk_notifpref_user FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
