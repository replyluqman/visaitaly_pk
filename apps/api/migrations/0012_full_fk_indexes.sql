-- 0012_full_fk_indexes
--
-- EXPAND-ONLY: five plain indexes. Rollback = DROP INDEX.
--
-- Why: a foreign key needs an UNCONDITIONAL index on the referencing column. A partial index
-- (WHERE status = 'active', …) satisfied the old audit by its leading column, but Postgres cannot use it
-- for the unconditional lookups a parent delete / cascade / SET NULL performs, or for erasure
-- (`DELETE … WHERE user_id = $1` across ALL statuses). Gate 4 caught the erasure query seq-scanning
-- `documents` (208k rows) and `applicants` (75k). The CI + preflight audit now rejects partial-only coverage.
--
-- Plain CREATE INDEX (not CONCURRENTLY) because the migration runner wraps each file in a transaction;
-- on a populated production table run these during a quiet window or apply with CONCURRENTLY by hand first
-- (the IF NOT EXISTS makes this migration a no-op afterwards).

-- Erasure + cascade: DELETE FROM applicants WHERE user_id = $1.
CREATE INDEX IF NOT EXISTS applicants_user_idx ON applicants (user_id);
-- Erasure: documents of any status for a user; cascade from applicants.
CREATE INDEX IF NOT EXISTS documents_user_idx ON documents (user_id);
CREATE INDEX IF NOT EXISTS documents_applicant_all_idx ON documents (applicant_id);
-- ON DELETE SET NULL fired for every applicant_requirements row removed with an applicant.
CREATE INDEX IF NOT EXISTS documents_requirement_all_idx ON documents (applicant_requirement_id);
-- A source's flag history (also covers the FK for any status).
CREATE INDEX IF NOT EXISTS source_flags_source_idx ON source_flags (source_id, detected_at DESC);
