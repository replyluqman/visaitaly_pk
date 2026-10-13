-- Module 2: legal version stamping, relationship reference data, applicant profiles,
-- onboarding transitions, premium lifecycle columns.
--
-- PRD §2 (account model, relationship categories), §6 (zero hardcoding),
-- §7 (premium lifecycle, grace, renewal), §11 (onboarding), §12 (journey stages),
-- §14 (Nulla Osta tracking), §18 (disclaimer version stamping), §19 (data minimisation).
-- Screens §4 Disclaimer Gate, §5 Applicant Count, §6 Profile Setup, §7 Stage Select,
-- §10 Applicant Case View, §29 Account/Settings.

-- ---------------------------------------------------------------------------
-- app_config additions (PRD §6)
-- ---------------------------------------------------------------------------
INSERT INTO app_config (key, value, description) VALUES
  ('onboarding',
   '{"max_applicants": 10}'::jsonb,
   'Abuse ceiling on applicants per account. PRD §2 sets no product limit; this is a guard, not a paywall.'),
  ('nulla_osta',
   '{"validity_months": 6, "expiry_warning_days": 30}'::jsonb,
   'PROVISIONAL. PRD §14 requires validity to come from the latest verified requirement. Until the requirements CMS lands (Module 4) this key is the source; after that it is the fallback only. expiry_warning_days is consumed by the Cron reminder sweep (Module 5).');

-- ---------------------------------------------------------------------------
-- relationships: the user-facing relation to the sponsor (wife, son, father…),
-- each mapping to one of the three locked requirement categories (PRD §2).
--
-- A lookup table rather than a CHECK constraint because the code list is content:
-- adding "brother" must not need an app release or a migration. The *category*
-- list IS locked product structure, so that stays a CHECK.
--
-- labels is jsonb keyed by locale so Urdu (PRD §11a) needs no ALTER.
-- ---------------------------------------------------------------------------
CREATE TABLE relationships (
  code         text PRIMARY KEY,
  labels       jsonb       NOT NULL,
  category     text        NOT NULL,
  requires_dob boolean     NOT NULL DEFAULT false,
  sort_order   integer     NOT NULL DEFAULT 0,
  is_active    boolean     NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT relationships_category_chk  CHECK (category IN ('spouse','child','parent')),
  CONSTRAINT relationships_labels_en_chk CHECK (labels ? 'en')
);

CREATE INDEX relationships_active_idx ON relationships (sort_order) WHERE is_active;

CREATE TRIGGER relationships_set_updated_at
  BEFORE UPDATE ON relationships
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- requires_dob: child needs DOB for the minor/adult rule, parent for the
-- age/dependency rule. Spouse is false at MVP. These are CMS-tunable flags,
-- not law — confirm with the content owner during requirement verification.
INSERT INTO relationships (code, labels, category, requires_dob, sort_order) VALUES
  ('wife',     '{"en":"Wife"}'::jsonb,     'spouse', false, 10),
  ('husband',  '{"en":"Husband"}'::jsonb,  'spouse', false, 20),
  ('son',      '{"en":"Son"}'::jsonb,      'child',  true,  30),
  ('daughter', '{"en":"Daughter"}'::jsonb, 'child',  true,  40),
  ('mother',   '{"en":"Mother"}'::jsonb,   'parent', true,  50),
  ('father',   '{"en":"Father"}'::jsonb,   'parent', true,  60);

-- ---------------------------------------------------------------------------
-- legal_versions: PRD §18 requires proving which terms version a user accepted.
-- Screens §44 is the admin version manager.
--
-- body_md lives in Neon, not R2: a few KB of text, and the Disclaimer Gate is a
-- blocking screen that must not wait on a second fetch.
-- Versions are expected to be kept in lockstep across locales — acceptance is
-- matched on (doc_type, version), so accepting en 1.0 satisfies ur 1.0.
-- ---------------------------------------------------------------------------
CREATE TABLE legal_versions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_type     text        NOT NULL,
  locale       text        NOT NULL DEFAULT 'en',
  version      text        NOT NULL,
  title        text        NOT NULL,
  body_md      text        NOT NULL,
  is_mandatory boolean     NOT NULL DEFAULT true,
  is_current   boolean     NOT NULL DEFAULT false,
  published_at timestamptz,
  published_by uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT legal_versions_doc_type_chk  CHECK (doc_type IN ('disclaimer','terms','privacy')),
  CONSTRAINT legal_versions_published_chk CHECK (is_current = false OR published_at IS NOT NULL)
);

CREATE UNIQUE INDEX legal_versions_doc_locale_version_uq
  ON legal_versions (doc_type, locale, version);

-- Exactly one current version per document per locale.
CREATE UNIQUE INDEX legal_versions_current_uq
  ON legal_versions (doc_type, locale)
  WHERE is_current;

CREATE TRIGGER legal_versions_set_updated_at
  BEFORE UPDATE ON legal_versions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- legal_acceptances: the audit record. ON DELETE RESTRICT on the version —
-- a version somebody accepted must never be deletable (PRD §18 legal defence).
-- device_id is recorded because we already hold it; no IP address (PRD §19
-- data minimisation).
-- ---------------------------------------------------------------------------
CREATE TABLE legal_acceptances (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  legal_version_id uuid        NOT NULL REFERENCES legal_versions(id) ON DELETE RESTRICT,
  device_id        uuid,
  app_version      text,
  accepted_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX legal_acceptances_user_version_uq
  ON legal_acceptances (user_id, legal_version_id);

CREATE INDEX legal_acceptances_user_idx ON legal_acceptances (user_id);

-- No legal content is seeded here.
--
-- Legal text is CONTENT, not schema. Shipping it in a migration means the
-- placeholder is baked into schema history and reaches every environment the
-- chain is ever applied to, including production, before anyone can review it.
-- The dev disclaimer now lives in seed/seed_dev_legal.sql and is applied by
-- hand; the real 1.0 is published through the CMS (Screens §44).
--
-- Consequence in a fresh dev database: /v1/legal/current returns 404 and
-- onboarding stays at disclaimer_pending until the seed is run. That is the
-- intended behaviour — it is exactly what production looks like before legal
-- text is published, so it gets exercised in dev instead of on launch day.

-- ---------------------------------------------------------------------------
-- users: Screen 5 answer. Declared intent, NOT a count of rows — the real count
-- is always count(applicants). Kept because it drives the onboarding loop, lets
-- an abandoned signup resume at the right applicant, and is the signup→profile
-- funnel metric (PRD §21).
-- ---------------------------------------------------------------------------
ALTER TABLE users ADD COLUMN declared_applicant_count smallint;

ALTER TABLE users ADD CONSTRAINT users_declared_applicant_count_chk
  CHECK (declared_applicant_count IS NULL OR declared_applicant_count BETWEEN 1 AND 99);

-- ---------------------------------------------------------------------------
-- applicants: one account → many independent applicants (PRD §2).
-- Requirements never merge across applicants, so every rule input is per-row.
--
-- current_stage is NULLABLE on purpose: NULL means Screen 7 has not run yet,
-- which is what drives onboarding_state = 'stage_pending'. A DEFAULT would make
-- "not chosen" indistinguishable from "chose the first stage".
--
-- relationship_category is denormalised from relationships.category so the
-- Module 3 checklist query never joins on the request path (10 ms CPU ceiling).
-- Remapping a relationship's category in CMS therefore requires a backfill.
-- ---------------------------------------------------------------------------
CREATE TABLE applicants (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                  uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- profile (Screens §6) — minimum necessary only (PRD §19)
  display_name             text        NOT NULL,
  relationship_code        text        NOT NULL REFERENCES relationships(code) ON DELETE RESTRICT,
  relationship_category    text        NOT NULL,
  date_of_birth            date,
  current_location         text        NOT NULL,

  -- journey (PRD §12)
  current_stage            text,
  stage_updated_at         timestamptz,
  -- Set by the checklist engine when the case is actually generated (Module 3).
  -- Stays NULL while generateCase() is a stub — do not set it from Module 2.
  case_generated_at        timestamptz,

  -- Nulla Osta tracker (PRD §14). The uploaded scan arrives later as a
  -- checklist item document (Module 3); these columns are the tracker.
  nulla_osta_status        text        NOT NULL DEFAULT 'not_started',
  nulla_osta_issue_date    date,
  nulla_osta_expiry_date   date,

  -- premium lifecycle (PRD §7). Written by the orders/expiry modules; read here.
  premium_status           text        NOT NULL DEFAULT 'none',
  access_until             timestamptz,
  visa_status              text,
  visa_granted_self_at     timestamptz,
  visa_granted_verified_at timestamptz,
  grace_until              timestamptz,

  status                   text        NOT NULL DEFAULT 'active',
  deleted_at               timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT applicants_category_chk CHECK (relationship_category IN ('spouse','child','parent')),
  CONSTRAINT applicants_location_chk CHECK (current_location IN ('pakistan','italy','other')),
  CONSTRAINT applicants_stage_chk CHECK (
    current_stage IS NULL OR current_stage IN
      ('eligibility','nulla_osta','documents','translation',
       'appointment','application','processing','decision')
  ),
  CONSTRAINT applicants_nulla_osta_status_chk CHECK (
    nulla_osta_status IN ('not_applicable','not_started','in_process','received')
  ),
  CONSTRAINT applicants_nulla_osta_dates_chk CHECK (
    nulla_osta_expiry_date IS NULL OR nulla_osta_issue_date IS NULL
    OR nulla_osta_expiry_date >= nulla_osta_issue_date
  ),
  CONSTRAINT applicants_premium_status_chk CHECK (
    premium_status IN ('none','active','expired_pending_confirmation','expired')
  ),
  CONSTRAINT applicants_visa_status_chk CHECK (
    visa_status IS NULL OR visa_status IN ('visa_granted','visa_granted_verified')
  ),
  CONSTRAINT applicants_status_chk CHECK (status IN ('active','deleted')),
  CONSTRAINT applicants_deleted_consistency_chk CHECK (
    (status = 'deleted') = (deleted_at IS NOT NULL)
  )
);

-- date_of_birth <= today is NOT a CHECK constraint: CURRENT_DATE is STABLE, not
-- IMMUTABLE, and Postgres rejects it there. Enforced in the zod schema instead.

CREATE INDEX applicants_user_active_idx
  ON applicants (user_id, created_at)
  WHERE status = 'active';

-- Entitlement resolution on every /v1/me call (PRD §5).
CREATE INDEX applicants_user_premium_idx
  ON applicants (user_id)
  WHERE status = 'active' AND premium_status <> 'none';

-- Cron sweeps (Module 5 reminders, Module 7 expiry). Created now to avoid a
-- later ALTER on a table other modules already depend on.
CREATE INDEX applicants_nulla_osta_expiry_idx
  ON applicants (nulla_osta_expiry_date)
  WHERE status = 'active' AND nulla_osta_expiry_date IS NOT NULL;

CREATE INDEX applicants_access_until_idx
  ON applicants (access_until)
  WHERE status = 'active' AND access_until IS NOT NULL;

CREATE TRIGGER applicants_set_updated_at
  BEFORE UPDATE ON applicants
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- applicant_stage_events: append-only stage history. Not required by any screen,
-- but journey completion > 40% (PRD §21) is unmeasurable without it and it
-- cannot be backfilled. Cheap now, impossible later.
-- ---------------------------------------------------------------------------
CREATE TABLE applicant_stage_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  applicant_id uuid        NOT NULL REFERENCES applicants(id) ON DELETE CASCADE,
  from_stage   text,
  to_stage     text        NOT NULL,
  source       text        NOT NULL DEFAULT 'user',
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT applicant_stage_events_source_chk CHECK (source IN ('user','admin','system'))
);

CREATE INDEX applicant_stage_events_applicant_idx
  ON applicant_stage_events (applicant_id, created_at DESC);
