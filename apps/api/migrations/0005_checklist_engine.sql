-- 0005_checklist_engine  (Module 3 — ADR 0010, docs/ERD.md §Module 3)
--
-- EXPAND-ONLY: four new tables and one app_config row. No existing column is touched,
-- so rollback is a plain DROP in reverse order and nothing is breaking.
--
-- NO CONTENT HERE (ADR 0007): requirement definitions live in seed/ and, later, the CMS.
-- app_config defaults are schema-adjacent and do belong in a migration.
--
-- Retention:
--   source_flags          resolved/dismissed rows are deleted after 24 months by the Module 4 Cron.
--   applicant_requirements  not append-only; lives and dies with its applicant (ON DELETE CASCADE).
--   requirements / sources  CMS-owned catalogue; archived, never deleted.

-- ---------------------------------------------------------------------------
-- sources: one row per authoritative URL (PRD §13 — authoritative sources only)
-- ---------------------------------------------------------------------------
CREATE TABLE sources (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  url             text        NOT NULL,
  name            jsonb       NOT NULL,
  authority       text        NOT NULL,
  last_hash       text,
  last_checked_at timestamptz,
  last_changed_at timestamptz,
  is_active       boolean     NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sources_authority_chk CHECK (authority IN ('embassy','government','service_provider')),
  CONSTRAINT sources_url_https_chk CHECK (url LIKE 'https://%')
);

CREATE UNIQUE INDEX sources_url_uq ON sources (url);
-- Serves the daily hash sweep: oldest-checked active source first.
CREATE INDEX sources_sweep_idx ON sources (last_checked_at) WHERE is_active;

CREATE TRIGGER sources_set_updated_at BEFORE UPDATE ON sources
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- source_flags: hash-change queue. The user-facing "Source updated — under review"
-- badge is derived from an OPEN flag on the requirement's source (PRD §13).
-- resolved_by has no FK until the admin table exists (Module 10).
-- ---------------------------------------------------------------------------
CREATE TABLE source_flags (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id       uuid        NOT NULL REFERENCES sources(id) ON DELETE RESTRICT,
  old_hash        text,
  new_hash        text        NOT NULL,
  detected_at     timestamptz NOT NULL DEFAULT now(),
  status          text        NOT NULL DEFAULT 'open',
  resolved_by     uuid,
  resolved_at     timestamptz,
  resolution_note text,
  CONSTRAINT source_flags_status_chk CHECK (status IN ('open','resolved','dismissed')),
  CONSTRAINT source_flags_resolved_chk CHECK ((status = 'open') = (resolved_at IS NULL))
);

-- Badge lookup (WHERE source_id = $1 AND status = 'open') and FK cover in one; also
-- enforces at most one open flag per source.
CREATE UNIQUE INDEX source_flags_open_uq ON source_flags (source_id) WHERE status = 'open';
-- Retention sweep: resolved flags older than 24 months.
CREATE INDEX source_flags_resolved_idx ON source_flags (resolved_at) WHERE status <> 'open';

-- ---------------------------------------------------------------------------
-- requirements: the catalogue (CMS-owned content, final read shape)
-- last_verified_by has no FK until the admin table exists (Module 10).
-- ---------------------------------------------------------------------------
CREATE TABLE requirements (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code                      text        NOT NULL,
  stage                     text        NOT NULL,
  -- Derived once so list ordering is an index scan, not a per-row CASE.
  stage_order               smallint GENERATED ALWAYS AS (
    CASE stage
      WHEN 'eligibility'  THEN 1 WHEN 'nulla_osta'  THEN 2 WHEN 'documents'  THEN 3
      WHEN 'translation'  THEN 4 WHEN 'appointment' THEN 5 WHEN 'application' THEN 6
      WHEN 'processing'   THEN 7 WHEN 'decision'    THEN 8
    END) STORED,
  title                     jsonb       NOT NULL,
  purpose                   jsonb,
  who_provides              jsonb,
  where_to_obtain           jsonb,
  recommended_timing        jsonb,

  -- declarative applicability (ADR 0010 #2)
  applies_spouse            boolean     NOT NULL DEFAULT true,
  applies_child             boolean     NOT NULL DEFAULT true,
  applies_parent            boolean     NOT NULL DEFAULT true,
  applies_locations         text[],
  min_age_years             smallint,
  max_age_years             smallint,
  requires_nulla_osta_status text[],
  na_reason                 jsonb,

  is_conditional            boolean     NOT NULL DEFAULT false,
  condition_note            jsonb,
  translation_required      boolean     NOT NULL DEFAULT false,
  apostille_required        boolean     NOT NULL DEFAULT false,
  blocks_submission         boolean     NOT NULL DEFAULT false,
  validity_days             integer,

  source_id                 uuid        REFERENCES sources(id) ON DELETE RESTRICT,
  source_document           text,
  source_published_at       date,

  verification_status       text        NOT NULL DEFAULT 'created',
  last_verified_at          timestamptz,
  last_verified_by          uuid,
  version                   integer     NOT NULL DEFAULT 1,
  sort_order                integer     NOT NULL DEFAULT 0,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT requirements_stage_chk CHECK (stage IN
    ('eligibility','nulla_osta','documents','translation','appointment','application','processing','decision')),
  CONSTRAINT requirements_status_chk CHECK (verification_status IN
    ('created','verified','published','reviewed','archived')),
  CONSTRAINT requirements_locations_chk CHECK (
    applies_locations IS NULL OR applies_locations <@ ARRAY['pakistan','italy','other']),
  CONSTRAINT requirements_age_chk CHECK (
    (min_age_years IS NULL OR min_age_years >= 0) AND (max_age_years IS NULL OR max_age_years >= 0)
    AND (min_age_years IS NULL OR max_age_years IS NULL OR min_age_years <= max_age_years)),
  CONSTRAINT requirements_version_chk CHECK (version >= 1),
  -- PRD §13: a requirement cannot be published without a verification record.
  CONSTRAINT requirements_published_verified_chk CHECK (
    verification_status NOT IN ('published','reviewed')
    OR (source_id IS NOT NULL AND last_verified_at IS NOT NULL))
);

CREATE UNIQUE INDEX requirements_code_uq ON requirements (code);
-- Generation + journey order: published catalogue in journey order.
CREATE INDEX requirements_published_idx ON requirements (stage_order, sort_order)
  WHERE verification_status = 'published';
-- FK cover; also "which requirements cite this source" on a hash flag.
CREATE INDEX requirements_source_idx ON requirements (source_id);

-- version bumps on every content edit (ADR 0010 #4) — conflict detection keys off it.
CREATE FUNCTION requirements_bump_version() RETURNS trigger AS $$
BEGIN
  IF ROW(NEW.title, NEW.purpose, NEW.who_provides, NEW.where_to_obtain, NEW.recommended_timing,
         NEW.applies_spouse, NEW.applies_child, NEW.applies_parent, NEW.applies_locations,
         NEW.min_age_years, NEW.max_age_years, NEW.requires_nulla_osta_status, NEW.na_reason,
         NEW.is_conditional, NEW.condition_note, NEW.translation_required, NEW.apostille_required,
         NEW.blocks_submission, NEW.validity_days, NEW.source_id, NEW.source_document,
         NEW.source_published_at, NEW.stage)
     IS DISTINCT FROM
     ROW(OLD.title, OLD.purpose, OLD.who_provides, OLD.where_to_obtain, OLD.recommended_timing,
         OLD.applies_spouse, OLD.applies_child, OLD.applies_parent, OLD.applies_locations,
         OLD.min_age_years, OLD.max_age_years, OLD.requires_nulla_osta_status, OLD.na_reason,
         OLD.is_conditional, OLD.condition_note, OLD.translation_required, OLD.apostille_required,
         OLD.blocks_submission, OLD.validity_days, OLD.source_id, OLD.source_document,
         OLD.source_published_at, OLD.stage)
  THEN
    NEW.version := OLD.version + 1;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER requirements_bump_version BEFORE UPDATE ON requirements
  FOR EACH ROW EXECUTE FUNCTION requirements_bump_version();

-- ---------------------------------------------------------------------------
-- applicant_requirements: the user's case (≈2M rows at 30k users)
-- user_id is denormalised so every ownership check is a single-table WHERE.
-- not_applicable is DERIVED from is_applicable (invariant 8); only 4 statuses stored.
-- ---------------------------------------------------------------------------
CREATE TABLE applicant_requirements (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                  uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  applicant_id             uuid        NOT NULL REFERENCES applicants(id) ON DELETE CASCADE,
  requirement_id           uuid        NOT NULL REFERENCES requirements(id) ON DELETE RESTRICT,
  status                   text        NOT NULL DEFAULT 'not_started',
  is_applicable            boolean     NOT NULL,
  needs_review             boolean     NOT NULL DEFAULT false,
  seen_requirement_version integer     NOT NULL,
  status_updated_at        timestamptz NOT NULL DEFAULT now(),
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT applicant_requirements_status_chk CHECK (
    status IN ('not_started','in_progress','ready','issue_found'))
);

-- Idempotent generation target + list-by-applicant (covers the applicant_id FK).
CREATE UNIQUE INDEX applicant_requirements_applicant_req_uq
  ON applicant_requirements (applicant_id, requirement_id);
-- Ownership WHERE for item reads/writes; covers the user_id FK.
CREATE INDEX applicant_requirements_user_applicant_idx
  ON applicant_requirements (user_id, applicant_id);
-- FK cover + "affected applicants" fan-out when a requirement is published/changed.
CREATE INDEX applicant_requirements_requirement_idx
  ON applicant_requirements (requirement_id);

CREATE TRIGGER applicant_requirements_set_updated_at BEFORE UPDATE ON applicant_requirements
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- config default (schema-adjacent, so it belongs here). Must match
-- CHECKLIST_CONFIG_FALLBACK in src/lib/app-config.ts.
-- ---------------------------------------------------------------------------
INSERT INTO app_config (key, value) VALUES ('checklist', '{"free_preview_items": 3}'::jsonb)
ON CONFLICT (key) DO NOTHING;
