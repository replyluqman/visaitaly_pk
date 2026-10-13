-- Rollback for 0009. Drops the published-version history (requirement_versions) — export it first on any
-- environment that has published real content: it is the record of what users were told and when.
DELETE FROM app_config WHERE key = 'verification';

-- restore the 0005 trigger body (bump on every content edit)
CREATE OR REPLACE FUNCTION requirements_bump_version() RETURNS trigger AS $$
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

DROP INDEX IF EXISTS requirements_status_idx;
DROP INDEX IF EXISTS source_flags_resolved_by_idx;
ALTER TABLE source_flags DROP CONSTRAINT IF EXISTS source_flags_resolved_by_fk;
DROP INDEX IF EXISTS requirements_last_verified_by_idx;
ALTER TABLE requirements DROP CONSTRAINT IF EXISTS requirements_last_verified_by_fk;
ALTER TABLE sources DROP COLUMN IF EXISTS consecutive_failures;
ALTER TABLE sources DROP COLUMN IF EXISTS last_error;
DROP TRIGGER IF EXISTS requirement_versions_immutable ON requirement_versions;
DROP FUNCTION IF EXISTS requirement_versions_immutable();
DROP TABLE IF EXISTS requirement_versions;
