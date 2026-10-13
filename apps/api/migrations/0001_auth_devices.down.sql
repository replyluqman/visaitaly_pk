-- Rollback for 0001_auth_devices.sql
-- SAFE AT THIS POINT: no other module depends on these tables yet.
-- BREAKING once Module 2 (applicants) lands — applicants.user_id will FK to users.
--   After that, rolling back 0001 requires rolling back every later migration first.
-- DATA LOSS: drops all accounts, device sessions and config. Irreversible.

DROP TABLE IF EXISTS devices;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS app_config;
DROP FUNCTION IF EXISTS set_updated_at();
