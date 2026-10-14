-- 0013_support  (Module 8 — docs/ERD.md §Module 8, PRD §10/§14a, Screens §25/§35)
--
-- EXPAND-ONLY: four new tables + config. Rollback = DROP (warns: it drops conversations and attachments metadata).
--
-- NO COPY HERE (ADR 0007): canned responses are lawyer-reviewed content authored in the CMS/seed.
-- The working-hours WINDOWS are structural config and ship as a default; the human-readable
-- `working_hours_text` is copy and is deliberately NOT defaulted here (preflight warns until set).
--
-- Retention (declared here per the schema protocol):
--   support_threads / support_messages / support_attachments  CLOSED threads are deleted 24 months after their
--     last message, together with their R2 objects (app_config.support.retention_months). Open threads are kept.
--     Account erasure removes them at once (DATA-PRIVACY §4).

CREATE TABLE support_threads (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status                text        NOT NULL DEFAULT 'open',
  tier                  text        NOT NULL DEFAULT 'free',
  sla_due_at            timestamptz,
  assigned_admin_id     uuid        REFERENCES admins(id) ON DELETE SET NULL,
  last_message_at       timestamptz,
  last_user_message_at  timestamptz,
  closed_at             timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT support_threads_status_chk CHECK (status IN ('open','awaiting_support','awaiting_user','closed')),
  CONSTRAINT support_threads_tier_chk CHECK (tier IN ('free','paid')),
  CONSTRAINT support_threads_closed_chk CHECK ((status = 'closed') = (closed_at IS NOT NULL)),
  -- A deadline exists exactly while the ball is in support's court.
  CONSTRAINT support_threads_sla_chk CHECK ((status = 'awaiting_support') = (sla_due_at IS NOT NULL))
);

-- One thread per user (PRD §10); also the user FK cover.
CREATE UNIQUE INDEX support_threads_user_uq ON support_threads (user_id);
-- The admin inbox, sorted by SLA deadline (Screen 35).
CREATE INDEX support_threads_sla_idx ON support_threads (sla_due_at, id) WHERE status = 'awaiting_support';
-- Admin list by state, newest activity first.
CREATE INDEX support_threads_status_idx ON support_threads (status, last_message_at DESC, id);
-- FK cover + "my threads".
CREATE INDEX support_threads_assignee_idx ON support_threads (assigned_admin_id);
-- Retention sweep of closed threads.
CREATE INDEX support_threads_retention_idx ON support_threads (last_message_at) WHERE status = 'closed';

CREATE TRIGGER support_threads_set_updated_at BEFORE UPDATE ON support_threads
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE canned_responses (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code            text        NOT NULL,
  title           text        NOT NULL,
  -- locale-keyed; placeholders {requirement_title} {requirement_deep_link} {source_name} {verified_days_ago}
  -- {working_hours_text} {order_ref} … are resolved from the thread context at send time.
  body            jsonb       NOT NULL,
  topic           text,
  -- requirement-link responses (PRD §10): the ONLY way a requirement question is answered
  requirement_id  uuid        REFERENCES requirements(id) ON DELETE SET NULL,
  is_active       boolean     NOT NULL DEFAULT true,
  updated_by      uuid        REFERENCES admins(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT canned_responses_code_chk CHECK (code ~ '^[a-z][a-z0-9_]{1,63}$'),
  CONSTRAINT canned_responses_body_chk CHECK (jsonb_typeof(body) = 'object' AND body ? 'en'),
  CONSTRAINT canned_responses_topic_chk CHECK (topic IS NULL OR topic IN
    ('payment','order','courier','refund','account','app_problem','presales'))
);

CREATE UNIQUE INDEX canned_responses_code_uq ON canned_responses (code);
CREATE INDEX canned_responses_requirement_idx ON canned_responses (requirement_id);
CREATE INDEX canned_responses_updated_by_idx ON canned_responses (updated_by);

CREATE TRIGGER canned_responses_set_updated_at BEFORE UPDATE ON canned_responses
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE support_messages (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id           uuid        NOT NULL REFERENCES support_threads(id) ON DELETE CASCADE,
  -- denormalised so ownership is a single-table WHERE
  user_id             uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sender_type         text        NOT NULL,
  admin_id            uuid        REFERENCES admins(id) ON DELETE SET NULL,
  body                text        NOT NULL,
  topic               text,
  canned_response_id  uuid        REFERENCES canned_responses(id) ON DELETE SET NULL,
  -- no FK until orders exist (Module 6)
  order_id            uuid,
  applicant_id        uuid        REFERENCES applicants(id) ON DELETE SET NULL,
  read_by_user_at     timestamptz,
  read_by_admin_at    timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT support_messages_sender_chk CHECK (sender_type IN ('user','admin','system')),
  -- a user's own message never carries an admin id
  CONSTRAINT support_messages_admin_chk CHECK (sender_type <> 'user' OR admin_id IS NULL),
  CONSTRAINT support_messages_body_chk CHECK (length(body) <= 4000),
  CONSTRAINT support_messages_topic_chk CHECK (topic IS NULL OR topic IN
    ('payment','order','courier','refund','account','app_problem','presales'))
);

-- Thread view (keyset, newest first) — also the thread FK cover.
CREATE INDEX support_messages_thread_idx ON support_messages (thread_id, created_at, id);
-- FK covers.
CREATE INDEX support_messages_user_idx ON support_messages (user_id);
CREATE INDEX support_messages_admin_idx ON support_messages (admin_id);
CREATE INDEX support_messages_applicant_idx ON support_messages (applicant_id);
CREATE INDEX support_messages_canned_idx ON support_messages (canned_response_id);
-- Unread count for the user (admin replies not yet read).
CREATE INDEX support_messages_unread_idx ON support_messages (thread_id) WHERE sender_type = 'admin' AND read_by_user_at IS NULL;

CREATE TABLE support_attachments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  thread_id   uuid        NOT NULL REFERENCES support_threads(id) ON DELETE CASCADE,
  message_id  uuid        REFERENCES support_messages(id) ON DELETE SET NULL,
  r2_key      text        NOT NULL,
  mime        text        NOT NULL,
  size_bytes  integer     NOT NULL,
  status      text        NOT NULL DEFAULT 'pending',
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT support_attachments_mime_chk CHECK (mime IN ('image/jpeg','image/png')),
  CONSTRAINT support_attachments_size_chk CHECK (size_bytes > 0),
  CONSTRAINT support_attachments_status_chk CHECK (status IN ('pending','attached','deleted'))
);

CREATE UNIQUE INDEX support_attachments_r2_key_uq ON support_attachments (r2_key);
CREATE INDEX support_attachments_user_idx ON support_attachments (user_id);
CREATE INDEX support_attachments_thread_idx ON support_attachments (thread_id);
CREATE INDEX support_attachments_message_idx ON support_attachments (message_id);
-- Cron: abandoned uploads.
CREATE INDEX support_attachments_purge_idx ON support_attachments (created_at) WHERE status <> 'attached';

-- ---------------------------------------------------------------------------
-- config (schema-adjacent). Must match SUPPORT_CONFIG_FALLBACK / SLA_CONFIG_FALLBACK.
--   topics_free: PRD §8 says free users get "pre-sales topics only (pricing, what's included, refund policy,
--   app problems)". `account` is added so a free user can report a device-session problem — CONFIG, not code:
--   remove it here if product disagrees.
--   Working hours: Mon–Sat 09:00–18:00 PKT (Screens §SLA example). Pakistan has no DST; offset is fixed.
-- ---------------------------------------------------------------------------
INSERT INTO app_config (key, value) VALUES
  ('support', '{"topics_free": ["presales","app_problem","account"], "messages_per_hour": 20, "attachment_max_bytes": 5242880, "attachment_upload_ttl_seconds": 900, "retention_months": 24}'::jsonb),
  ('sla',     '{"support_paid_hours": 24, "support_free_hours": 48, "working_hours_windows": {"utc_offset_minutes": 300, "days": [1,2,3,4,5,6], "start_minute": 540, "end_minute": 1080}}'::jsonb)
ON CONFLICT (key) DO NOTHING;
