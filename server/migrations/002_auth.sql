-- 002 : sessions, jetons e-mail, invitations, journal d'audit (Phase 3)

CREATE TABLE refresh_tokens (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id        BIGINT UNSIGNED NOT NULL,
  company_id     BIGINT UNSIGNED NOT NULL,
  token_hash     CHAR(64)  NOT NULL COMMENT 'SHA-256 du jeton ; le jeton en clair n''est jamais stocke',
  family_id      CHAR(36)  NOT NULL COMMENT 'Chaine de rotation ; reutilisation d''un jeton revoque => famille entiere revoquee',
  expires_at     TIMESTAMP NOT NULL,
  revoked_at     TIMESTAMP NULL DEFAULT NULL,
  replaced_by_id BIGINT UNSIGNED NULL,
  user_agent     VARCHAR(255) NULL,
  ip             VARCHAR(64)  NULL,
  created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_refresh_hash (token_hash),
  KEY idx_refresh_user (user_id),
  KEY idx_refresh_family (family_id),
  CONSTRAINT fk_refresh_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_refresh_company FOREIGN KEY (company_id) REFERENCES companies (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE email_tokens (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id    BIGINT UNSIGNED NOT NULL,
  type       ENUM('email_verify','password_reset') NOT NULL,
  token_hash CHAR(64)  NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  used_at    TIMESTAMP NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_email_token_hash (token_hash),
  KEY idx_email_token_user (user_id, type),
  CONSTRAINT fk_email_token_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE invitations (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  public_id   CHAR(36)     NOT NULL,
  company_id  BIGINT UNSIGNED NOT NULL,
  email       VARCHAR(190) NOT NULL,
  role_id     BIGINT UNSIGNED NOT NULL,
  token_hash  CHAR(64)     NOT NULL,
  invited_by  BIGINT UNSIGNED NOT NULL,
  expires_at  TIMESTAMP NOT NULL,
  accepted_at TIMESTAMP NULL DEFAULT NULL,
  revoked_at  TIMESTAMP NULL DEFAULT NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_invitation_public (public_id),
  UNIQUE KEY uq_invitation_hash (token_hash),
  KEY idx_invitation_company (company_id, email),
  CONSTRAINT fk_inv_company FOREIGN KEY (company_id) REFERENCES companies (id),
  CONSTRAINT fk_inv_role FOREIGN KEY (role_id) REFERENCES roles (id),
  CONSTRAINT fk_inv_by FOREIGN KEY (invited_by) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE audit_logs (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  company_id  BIGINT UNSIGNED NULL,
  user_id     BIGINT UNSIGNED NULL,
  action      VARCHAR(80)  NOT NULL,
  entity_type VARCHAR(60)  NULL,
  entity_id   VARCHAR(64)  NULL,
  ip          VARCHAR(64)  NULL,
  meta        JSON NULL COMMENT 'Jamais de mot de passe ni de jeton',
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_audit_company (company_id, created_at),
  KEY idx_audit_user (user_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
