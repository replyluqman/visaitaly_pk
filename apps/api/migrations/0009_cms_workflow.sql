-- 0009_cms_workflow  (Module 4b — docs/ERD.md §Module 4, PRD §13, Screens §39/§40)
--
-- EXPAND-ONLY: one new table, two columns, two foreign keys onto tables that already exist,
-- one app_config row. Rollback restores the previous schema exactly.
--
-- The two FKs are the "contract" step 0005 deferred ("no FK until the admin table exists"):
-- nothing referenced admins before 0008, so every existing value is NULL and VALIDATE is trivial.
--
-- Retention:
--   requirement_versions  append-only; kept forever — it is the legal-defence record of what was
--                         published when (PRD §18). Feeds the Updates tab and How We Verify.

-- ---------------------------------------------------------------------------
-- requirement_versions: one row per PUBLISHED content version (snapshot at publish time)
-- ---------------------------------------------------------------------------
CREATE TABLE requirement_versions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requirement_id uuid        NOT NULL REFERENCES requirements(id) ON DELETE RESTRICT,
  version        integer     NOT NULL,
  snapshot       jsonb       NOT NULL,
  -- locale-keyed, user-facing ("what changed"); NULL for the first publication
  change_summary jsonb,
  effective_date date        NOT NULL DEFAULT CURRENT_DATE,
  published_at   timestamptz NOT NULL DEFAULT now(),
  published_by   uuid        NOT NULL REFERENCES admins(id) ON DELETE RESTRICT,
  CONSTRAINT requirement_versions_version_chk CHECK (version >= 1),
  CONSTRAINT requirement_versions_snapshot_chk CHECK (jsonb_typeof(snapshot) = 'object')
);

-- One snapshot per content version (also the lookup for a requirement's history).
CREATE UNIQUE INDEX requirement_versions_req_version_uq ON requirement_versions (requirement_id, version);
-- "Recent updates" feed (How We Verify, Module 5 Updates tab): newest first.
CREATE INDEX requirement_versions_published_idx ON requirement_versions (published_at DESC, id DESC);
-- FK cover.
CREATE INDEX requirement_versions_published_by_idx ON requirement_versions (published_by);

-- Append-only: history cannot be edited or removed.
CREATE FUNCTION requirement_versions_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'requirement_versions is append-only';
END $$ LANGUAGE plpgsql;

CREATE TRIGGER requirement_versions_immutable BEFORE UPDATE OR DELETE ON requirement_versions
  FOR EACH ROW EXECUTE FUNCTION requirement_versions_immutable();

-- ---------------------------------------------------------------------------
-- sources: hash-sweep health (admins see which sources cannot be checked)
-- ---------------------------------------------------------------------------
ALTER TABLE sources ADD COLUMN last_error text;
ALTER TABLE sources ADD COLUMN consecutive_failures integer NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
-- deferred FKs onto admins
-- ---------------------------------------------------------------------------
ALTER TABLE requirements ADD CONSTRAINT requirements_last_verified_by_fk
  FOREIGN KEY (last_verified_by) REFERENCES admins(id) ON DELETE RESTRICT NOT VALID;
ALTER TABLE requirements VALIDATE CONSTRAINT requirements_last_verified_by_fk;
CREATE INDEX requirements_last_verified_by_idx ON requirements (last_verified_by);

ALTER TABLE source_flags ADD CONSTRAINT source_flags_resolved_by_fk
  FOREIGN KEY (resolved_by) REFERENCES admins(id) ON DELETE RESTRICT NOT VALID;
ALTER TABLE source_flags VALIDATE CONSTRAINT source_flags_resolved_by_fk;
CREATE INDEX source_flags_resolved_by_idx ON source_flags (resolved_by);

-- Admin list of requirements by workflow state.
CREATE INDEX requirements_status_idx ON requirements (verification_status, stage_order, sort_order, id);


-- ---------------------------------------------------------------------------
-- version semantics (replaces the 0005 trigger body): `version` counts PUBLISHED content revisions.
-- Edits to a requirement that has never been published are drafting, not revisions — without this,
-- the first publication would already be "version 4" and every client's baseVersion would start there.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION requirements_bump_version() RETURNS trigger AS $$
BEGIN
  IF (OLD.verification_status = 'published'
      OR EXISTS (SELECT 1 FROM requirement_versions rv WHERE rv.requirement_id = OLD.id))
     AND ROW(NEW.title, NEW.purpose, NEW.who_provides, NEW.where_to_obtain, NEW.recommended_timing,
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

-- Config default (schema-adjacent). Must match VERIFICATION_CONFIG_FALLBACK.
INSERT INTO app_config (key, value) VALUES
  ('verification', '{"hash_sweep_batch": 20, "fetch_timeout_ms": 10000, "max_body_bytes": 2000000, "failure_alert_after": 3}'::jsonb)
ON CONFLICT (key) DO NOTHING;
