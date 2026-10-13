-- Rollback for 0008. Drops every admin, permission and audit row — the audit log is the legal-defence
-- record (PRD §18). Export it first on any environment that holds real history.
DROP TRIGGER IF EXISTS audit_log_immutable ON audit_log;
DROP FUNCTION IF EXISTS audit_log_immutable();
DROP TABLE IF EXISTS audit_log;
DROP TABLE IF EXISTS admin_permissions;
DROP TABLE IF EXISTS admins;
