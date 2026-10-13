-- Rollback 0003.
-- Dropping an index is always safe: it removes a performance property, never
-- data and never a constraint. Queries fall back to the plans they had before
-- 0003 was applied.

DROP INDEX IF EXISTS applicants_relationship_code_idx;
DROP INDEX IF EXISTS legal_acceptances_legal_version_idx;
