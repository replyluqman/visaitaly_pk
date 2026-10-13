-- Rollback for 0005. Drops all checklist data (applicant_requirements is derivable from
-- requirements + applicants by regenerating the case, but user-set statuses are LOST).
-- Take a backup first if any environment holds real progress.
DELETE FROM app_config WHERE key = 'checklist';
DROP TABLE IF EXISTS applicant_requirements;
DROP TRIGGER IF EXISTS requirements_bump_version ON requirements;
DROP FUNCTION IF EXISTS requirements_bump_version();
DROP TABLE IF EXISTS requirements;
DROP TABLE IF EXISTS source_flags;
DROP TABLE IF EXISTS sources;
