-- 0003_fk_indexes.sql
--
-- Gate 4 finding: two foreign keys had no covering index on the referencing
-- side. Postgres indexes the referenced (parent) key automatically as part of
-- the PK/unique constraint, but never the child column. Every DELETE or key
-- UPDATE on the parent must then seq-scan the child to enforce the constraint.
--
--   applicants.relationship_code       -> relationships.code        (ON DELETE RESTRICT)
--   legal_acceptances.legal_version_id -> legal_versions.id
--
-- Neither is hot today. Both get worse monotonically: `applicants` reaches
-- ~75k rows at 30k users (docs/SCALE.md) and `legal_acceptances` grows with
-- every user x every published legal version. A CMS relationship edit or a
-- legal-version cleanup would scan the whole child table under a lock.
--
-- Purely additive (expand-only). No column, constraint or data is touched, so
-- there is no breaking change and the rollback is a plain DROP.
--
-- CONCURRENTLY is deliberately NOT used: it cannot run inside a transaction,
-- and scripts/migrate.mjs wraps each migration in one so a failure never leaves
-- a half-applied migration. These tables are small at the time this runs, so
-- the brief ACCESS SHARE lock is irrelevant. If either table is ever large when
-- an index is added, that index belongs in its own migration run manually with
-- CONCURRENTLY, outside the transactional runner.

CREATE INDEX IF NOT EXISTS applicants_relationship_code_idx
  ON applicants (relationship_code);

CREATE INDEX IF NOT EXISTS legal_acceptances_legal_version_idx
  ON legal_acceptances (legal_version_id);
