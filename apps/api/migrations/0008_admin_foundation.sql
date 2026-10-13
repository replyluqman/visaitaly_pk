-- 0008_admin_foundation  (ADR 0012, docs/ERD.md §Module 10, PRD §16)
--
-- EXPAND-ONLY: three new tables. Rollback = DROP in reverse order.
--
-- Retention:
--   audit_log  12 months hot, then the Module 10 Cron archives to R2 and deletes. The trigger below
--              refuses UPDATE always and DELETE of rows younger than 12 months, so the legal-defence
--              record (PRD §16/§18) cannot be rewritten or shortened by application code.
--   admins / admin_permissions  kept for life (disabled, never deleted — audit rows reference them).

CREATE TABLE admins (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- NULL until the pre-registered person first signs in with a verified matching email.
  firebase_uid  text,
  email         text        NOT NULL,
  display_name  text,
  is_super      boolean     NOT NULL DEFAULT false,
  status        text        NOT NULL DEFAULT 'active',
  created_by    uuid        REFERENCES admins(id) ON DELETE RESTRICT,
  last_login_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT admins_status_chk CHECK (status IN ('active','disabled')),
  CONSTRAINT admins_email_chk CHECK (email = lower(email) AND email LIKE '%@%')
);

-- Login lookup (WHERE firebase_uid = $1).
CREATE UNIQUE INDEX admins_firebase_uid_uq ON admins (firebase_uid) WHERE firebase_uid IS NOT NULL;
-- First-login linking (WHERE email = $1) and uniqueness of an identity.
CREATE UNIQUE INDEX admins_email_uq ON admins (email);
-- FK cover + "created by" lookups.
CREATE INDEX admins_created_by_idx ON admins (created_by);
-- Admin list (cursor on created_at, id).
CREATE INDEX admins_list_idx ON admins (created_at, id);

CREATE TRIGGER admins_set_updated_at BEFORE UPDATE ON admins
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE admin_permissions (
  admin_id   uuid        NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  scope      text        NOT NULL,
  granted_by uuid        REFERENCES admins(id) ON DELETE RESTRICT,
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (admin_id, scope),
  CONSTRAINT admin_permissions_scope_chk CHECK (scope IN (
    'payment_approve','translation_manage','appointment_manage','verification_manage',
    'referral_payout','cash_dept','pricing_config','legal_manage','expiry_manage',
    'support_manage','refund_manage','read_only'))
);
-- FK cover for granted_by.
CREATE INDEX admin_permissions_granted_by_idx ON admin_permissions (granted_by);

CREATE TABLE audit_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_type  text        NOT NULL,
  actor_id    uuid,
  action      text        NOT NULL,
  target_type text,
  target_id   text,
  -- ids and changed field NAMES only. Never PII values (SECURITY.md).
  metadata    jsonb       NOT NULL DEFAULT '{}'::jsonb,
  request_id  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT audit_log_actor_chk CHECK (actor_type IN ('admin','user','system')),
  CONSTRAINT audit_log_metadata_chk CHECK (jsonb_typeof(metadata) = 'object')
);

-- Per-target history, per-actor history, and the time-ordered viewer / retention sweep.
CREATE INDEX audit_log_target_idx ON audit_log (target_type, target_id, created_at DESC);
CREATE INDEX audit_log_actor_idx  ON audit_log (actor_id, created_at DESC);
CREATE INDEX audit_log_created_idx ON audit_log (created_at DESC, id DESC);
-- Viewer filtered by action (a rare action must not scan the whole log).
CREATE INDEX audit_log_action_idx ON audit_log (action, created_at DESC, id DESC);

CREATE FUNCTION audit_log_immutable() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'audit_log is append-only';
  END IF;
  IF OLD.created_at > now() - interval '12 months' THEN
    RAISE EXCEPTION 'audit_log rows younger than 12 months cannot be deleted';
  END IF;
  RETURN OLD;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER audit_log_immutable BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();
