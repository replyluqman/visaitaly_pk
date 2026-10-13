-- 0011_privacy_legal  (Module 10a — docs/DATA-PRIVACY.md, PRD §16/§18/§19, Screens §36/§44)
--
-- EXPAND-ONLY: two new tables, one index, one FK + trigger on an existing table, config.
-- Rollback restores the previous schema.
--
-- Retention:
--   data_requests  kept 6 YEARS (proof of GDPR compliance, DATA-PRIVACY §ERD). Holds no PII beyond a user id
--                  and, for a pending deletion only, the Firebase uid (cleared once the identity is deleted).
--   consents       life of the account (hard-deleted by the erasure job).

-- ---------------------------------------------------------------------------
-- data_requests: export + erasure. user_id deliberately has NO FK: the record must survive the
-- user (the users row is kept as a tombstone, but this table must not depend on that).
-- ---------------------------------------------------------------------------
CREATE TABLE data_requests (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid        NOT NULL,
  kind                text        NOT NULL,
  status              text        NOT NULL DEFAULT 'received',
  requested_at        timestamptz NOT NULL DEFAULT now(),
  started_at          timestamptz,
  completed_at        timestamptz,
  attempts            smallint    NOT NULL DEFAULT 0,
  last_error          text,
  -- export: the R2 object holding the JSON, until it expires
  r2_export_key       text,
  expires_at          timestamptz,
  -- delete: needed to remove the identity at Firebase after the tombstone has replaced users.firebase_uid
  firebase_uid        text,
  identity_deleted_at timestamptz,
  CONSTRAINT data_requests_kind_chk CHECK (kind IN ('export','delete')),
  CONSTRAINT data_requests_status_chk CHECK (status IN ('received','processing','completed','rejected','failed'))
);

-- The Cron queue.
CREATE INDEX data_requests_queue_idx ON data_requests (status, requested_at) WHERE status IN ('received','processing');
-- A user's own requests (status screen, cool-down check).
CREATE INDEX data_requests_user_idx ON data_requests (user_id, requested_at DESC);
-- One open export per user; one erasure per user.
CREATE UNIQUE INDEX data_requests_one_open_export_uq ON data_requests (user_id)
  WHERE kind = 'export' AND status IN ('received','processing');
CREATE UNIQUE INDEX data_requests_one_delete_uq ON data_requests (user_id)
  WHERE kind = 'delete' AND status <> 'rejected';
-- Expiry sweep of finished exports.
CREATE INDEX data_requests_export_expiry_idx ON data_requests (expires_at)
  WHERE kind = 'export' AND r2_export_key IS NOT NULL;

-- ---------------------------------------------------------------------------
-- consents (DATA-PRIVACY §2): analytics / crash reports / marketing push are OFF until granted.
-- ---------------------------------------------------------------------------
CREATE TABLE consents (
  user_id        uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose        text        NOT NULL,
  granted        boolean     NOT NULL,
  policy_version text,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, purpose),
  CONSTRAINT consents_purpose_chk CHECK (purpose IN ('analytics','crash_reports','marketing_push'))
);

-- Case Lookup by email (Screen 36). Not unique: identity is firebase_uid (0004).
CREATE INDEX users_email_lower_idx ON users (lower(email)) WHERE email IS NOT NULL;

-- ---------------------------------------------------------------------------
-- legal_versions: the deferred FK + immutability once published.
-- A published version is the text users accepted (PRD §18 legal defence): it can be superseded,
-- never edited. Only `is_current` may change after publication.
-- ---------------------------------------------------------------------------
ALTER TABLE legal_versions ADD CONSTRAINT legal_versions_published_by_fk
  FOREIGN KEY (published_by) REFERENCES admins(id) ON DELETE RESTRICT NOT VALID;
ALTER TABLE legal_versions VALIDATE CONSTRAINT legal_versions_published_by_fk;
CREATE INDEX legal_versions_published_by_idx ON legal_versions (published_by);

CREATE FUNCTION legal_versions_immutable() RETURNS trigger AS $$
BEGIN
  IF OLD.published_at IS NOT NULL AND (
       NEW.doc_type IS DISTINCT FROM OLD.doc_type OR NEW.locale IS DISTINCT FROM OLD.locale
    OR NEW.version IS DISTINCT FROM OLD.version OR NEW.title IS DISTINCT FROM OLD.title
    OR NEW.body_md IS DISTINCT FROM OLD.body_md OR NEW.is_mandatory IS DISTINCT FROM OLD.is_mandatory
    OR NEW.published_at IS DISTINCT FROM OLD.published_at OR NEW.published_by IS DISTINCT FROM OLD.published_by)
  THEN
    RAISE EXCEPTION 'a published legal version is immutable; publish a new version instead';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER legal_versions_immutable BEFORE UPDATE ON legal_versions
  FOR EACH ROW EXECUTE FUNCTION legal_versions_immutable();

-- "View acceptance records per version" (Screen 44): keyset by acceptance time.
CREATE INDEX legal_acceptances_version_time_idx ON legal_acceptances (legal_version_id, accepted_at, id);

-- Config (schema-adjacent). Must match PRIVACY_CONFIG_FALLBACK.
INSERT INTO app_config (key, value) VALUES
  ('privacy', '{"reauth_window_seconds": 300, "export_retention_days": 7, "export_cooldown_hours": 24, "export_download_ttl_seconds": 600, "delete_objects_per_run": 40, "max_attempts": 10, "export_row_cap": 5000}'::jsonb)
ON CONFLICT (key) DO NOTHING;
