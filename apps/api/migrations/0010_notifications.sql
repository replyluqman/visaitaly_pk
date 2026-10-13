-- 0010_notifications  (Module 5 — docs/ERD.md §Module 5, PRD §14, Screens §13)
--
-- EXPAND-ONLY: four new tables, config rows. Rollback = DROP.
--
-- NO COPY HERE (ADR 0007): notification wording is user-facing content. It lives in
-- notification_templates, populated from seed/ (dev) or the CMS; `pnpm preflight` fails a deploy
-- that lacks an English template for any notification type the code can emit.
--
-- Retention:
--   notifications  READ rows older than app_config.notifications.retention_days_read (90) are deleted
--                  by the Cron in batches; UNREAD rows are kept (SCALE.md). ≈ 1M rows/year at 30k users.
--   notification_dispatch  one row per published requirement version; kept (tiny, audit of fan-out).

CREATE TABLE notification_templates (
  type       text        NOT NULL,
  locale     text        NOT NULL,
  title      text        NOT NULL,
  -- Placeholders: {title} {changeSummary} {days} {date}. Plain text, substituted in SQL.
  body       text        NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (type, locale),
  CONSTRAINT notification_templates_locale_chk CHECK (locale ~ '^[a-z]{2}$'),
  CONSTRAINT notification_templates_len_chk CHECK (length(title) BETWEEN 1 AND 120 AND length(body) BETWEEN 1 AND 500)
);

CREATE TRIGGER notification_templates_set_updated_at BEFORE UPDATE ON notification_templates
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE notifications (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  applicant_id    uuid        REFERENCES applicants(id) ON DELETE CASCADE,
  tab             text        NOT NULL,
  type            text        NOT NULL,
  title           text        NOT NULL,
  body            text        NOT NULL,
  -- PRD §14 rule 3: a notification that cannot be acted on is noise.
  deep_link       text        NOT NULL,
  payload         jsonb       NOT NULL DEFAULT '{}'::jsonb,
  -- Cron idempotency: unique (user_id, dedupe_key).
  dedupe_key      text        NOT NULL,
  push_sent_at    timestamptz,
  push_attempts   smallint    NOT NULL DEFAULT 0,
  read_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notifications_tab_chk CHECK (tab IN ('reminder','update','activity')),
  CONSTRAINT notifications_type_chk CHECK (type ~ '^[a-z][a-z_]{1,47}$'),
  CONSTRAINT notifications_deep_link_chk CHECK (deep_link ~ '^/[A-Za-z0-9/_-]*$'),
  CONSTRAINT notifications_payload_chk CHECK (jsonb_typeof(payload) = 'object')
);

-- Idempotent generation + the user FK cover.
CREATE UNIQUE INDEX notifications_user_dedupe_uq ON notifications (user_id, dedupe_key);
-- Inbox: list per tab, newest first, keyset (WHERE user_id = $1 AND tab = $2 ORDER BY created_at DESC, id DESC).
CREATE INDEX notifications_inbox_idx ON notifications (user_id, tab, created_at DESC, id DESC);
-- The bell badge: a single indexed count of unread rows (PRD §4 constraint 5).
CREATE INDEX notifications_unread_idx ON notifications (user_id, tab) WHERE read_at IS NULL;
-- Push queue (Cron): oldest unsent first.
CREATE INDEX notifications_push_queue_idx ON notifications (created_at, id) WHERE push_sent_at IS NULL;
-- Retention sweep of read rows.
CREATE INDEX notifications_retention_idx ON notifications (read_at) WHERE read_at IS NOT NULL;
-- FK cover.
CREATE INDEX notifications_applicant_idx ON notifications (applicant_id);

CREATE TABLE notification_preferences (
  user_id    uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tab        text        NOT NULL,
  channel    text        NOT NULL,
  enabled    boolean     NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, tab, channel),
  CONSTRAINT notification_prefs_tab_chk CHECK (tab IN ('reminder','update','activity')),
  CONSTRAINT notification_prefs_channel_chk CHECK (channel IN ('push','in_app')),
  -- Neon is the record: the in-app inbox cannot be switched off (PRD §14 rule 1).
  CONSTRAINT notification_prefs_inapp_chk CHECK (channel <> 'in_app' OR enabled)
);

-- Which published requirement versions have been turned into notifications.
CREATE TABLE notification_dispatch (
  requirement_version_id uuid PRIMARY KEY REFERENCES requirement_versions(id) ON DELETE RESTRICT,
  dispatched_at          timestamptz NOT NULL DEFAULT now(),
  notifications_created  integer     NOT NULL DEFAULT 0
);

-- ---------------------------------------------------------------------------
-- config (schema-adjacent). Must match the *_CONFIG_FALLBACK constants.
-- ---------------------------------------------------------------------------
INSERT INTO app_config (key, value) VALUES
  ('notifications', '{"push_max_per_run": 40, "push_max_attempts": 3, "retention_days_read": 90, "retention_batch": 5000}'::jsonb),
  ('reminders',     '{"days_before": [30, 7, 1], "batch_size": 5000}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- Two tunables added to existing keys. `||` merges, so any value an admin already set is kept.
UPDATE app_config SET value = '{"recheck_after_hours": 20}'::jsonb || value WHERE key = 'verification';
UPDATE app_config SET value = '{"min_age_minutes": 30}'::jsonb || value WHERE key = 'today';
