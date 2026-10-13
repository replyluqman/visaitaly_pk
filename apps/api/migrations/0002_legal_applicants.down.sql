-- Rollback for 0002_legal_applicants.sql
--
-- SAFE AT THIS POINT: no other module depends on these tables yet.
-- BREAKING once Module 3 (checklist engine) lands — applicant_requirements.applicant_id
--   will FK to applicants. After that, rolling back 0002 requires rolling back 0003 first.
-- DATA LOSS: drops every applicant profile, stage history, and legal-acceptance
--   record. Acceptance records are the PRD §18 legal defence — never run this
--   against an environment that has real users.

DROP TABLE IF EXISTS applicant_stage_events;
DROP TABLE IF EXISTS applicants;
DROP TABLE IF EXISTS legal_acceptances;
DROP TABLE IF EXISTS legal_versions;
DROP TABLE IF EXISTS relationships;

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_declared_applicant_count_chk;
ALTER TABLE users DROP COLUMN IF EXISTS declared_applicant_count;

DELETE FROM app_config WHERE key IN ('onboarding','nulla_osta');
