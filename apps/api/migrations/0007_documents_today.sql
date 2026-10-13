-- 0007_documents_today  (Module 3b — ADR 0010, docs/ERD.md §Module 3b)
--
-- EXPAND-ONLY: two new tables, two app_config rows. Rollback = DROP.
--
-- Retention:
--   documents    'pending' rows (upload never completed) are purged by Cron after 2x the
--                upload URL TTL, together with any R2 object; 'deleted' rows are kept 30 days
--                as an audit trail, then purged. 'active' rows live with the applicant/account.
--   next_actions one row per applicant, overwritten in place (bounded by applicants).
-- No filename is stored (PRD §19). r2_key is generated server-side from a uuid: unguessable.

CREATE TABLE documents (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                  uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  applicant_id             uuid        NOT NULL REFERENCES applicants(id) ON DELETE CASCADE,
  applicant_requirement_id uuid        REFERENCES applicant_requirements(id) ON DELETE SET NULL,
  r2_key                   text        NOT NULL,
  mime                     text        NOT NULL,
  size_bytes               bigint      NOT NULL,
  client_sha256            text        NOT NULL,
  expiry_date              date,
  status                   text        NOT NULL DEFAULT 'pending',
  created_at               timestamptz NOT NULL DEFAULT now(),
  completed_at             timestamptz,
  deleted_at               timestamptz,
  CONSTRAINT documents_status_chk CHECK (status IN ('pending','active','deleted')),
  CONSTRAINT documents_mime_chk CHECK (mime IN ('image/jpeg','image/png','application/pdf')),
  CONSTRAINT documents_size_chk CHECK (size_bytes > 0),
  CONSTRAINT documents_sha256_chk CHECK (client_sha256 ~ '^[a-f0-9]{64}$'),
  CONSTRAINT documents_state_chk CHECK (
    status <> 'active' OR (completed_at IS NOT NULL AND deleted_at IS NULL)),
  CONSTRAINT documents_deleted_chk CHECK ((status = 'deleted') = (deleted_at IS NOT NULL))
);

CREATE UNIQUE INDEX documents_r2_key_uq ON documents (r2_key);
-- My Documents cursor list (WHERE user_id = $1 AND status = 'active' ORDER BY created_at, id).
CREATE INDEX documents_user_active_idx ON documents (user_id, created_at, id) WHERE status = 'active';
-- Per-applicant list + FK cover.
CREATE INDEX documents_applicant_idx ON documents (applicant_id, created_at, id) WHERE status = 'active';
-- Item detail + documentCount + FK cover.
CREATE INDEX documents_item_idx ON documents (applicant_requirement_id) WHERE status = 'active';
-- Quota sum includes live pending rows.
CREATE INDEX documents_user_quota_idx ON documents (user_id) WHERE status IN ('active','pending');
-- Module 5 expiry reminders and the "expiring" Today rule.
CREATE INDEX documents_expiry_idx ON documents (expiry_date) WHERE status = 'active' AND expiry_date IS NOT NULL;
-- Cron purge of abandoned pending uploads and old deleted rows.
CREATE INDEX documents_purge_idx ON documents (created_at) WHERE status <> 'active';

-- ---------------------------------------------------------------------------
-- next_actions: materialised by the Cron Worker, never computed on a user request.
-- ---------------------------------------------------------------------------
CREATE TABLE next_actions (
  applicant_id uuid PRIMARY KEY REFERENCES applicants(id) ON DELETE CASCADE,
  user_id      uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actions      jsonb       NOT NULL DEFAULT '[]'::jsonb,
  computed_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT next_actions_array_chk CHECK (jsonb_typeof(actions) = 'array')
);
-- GET /v1/today (WHERE user_id = $1) and FK cover.
CREATE INDEX next_actions_user_idx ON next_actions (user_id);
-- Cron picks the stalest rows first.
CREATE INDEX next_actions_computed_idx ON next_actions (computed_at);

-- Config defaults (schema-adjacent). Must match UPLOADS_CONFIG_FALLBACK / TODAY_CONFIG_FALLBACK.
INSERT INTO app_config (key, value) VALUES
  ('uploads', '{"max_file_bytes": 10485760, "max_bytes_per_user": 524288000, "upload_url_ttl_seconds": 900, "view_url_ttl_seconds": 300, "deleted_retention_days": 30, "allowed_mimes": ["image/jpeg","image/png","application/pdf"]}'::jsonb),
  ('today',   '{"max_actions": 5, "expiry_window_days": 30, "batch_size": 15000}'::jsonb)
ON CONFLICT (key) DO NOTHING;
