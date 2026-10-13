-- Rollback for 0011. Drops the data-request history (the GDPR compliance record, kept 6 years) and consents.
-- Export data_requests first on any environment that has served real users.
DELETE FROM app_config WHERE key = 'privacy';
DROP INDEX IF EXISTS legal_acceptances_version_time_idx;
DROP TRIGGER IF EXISTS legal_versions_immutable ON legal_versions;
DROP FUNCTION IF EXISTS legal_versions_immutable();
DROP INDEX IF EXISTS legal_versions_published_by_idx;
ALTER TABLE legal_versions DROP CONSTRAINT IF EXISTS legal_versions_published_by_fk;
DROP INDEX IF EXISTS users_email_lower_idx;
DROP TABLE IF EXISTS consents;
DROP TABLE IF EXISTS data_requests;
