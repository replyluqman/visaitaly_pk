-- 0014_users_auth_columns (ADR 0013, migration-readiness checklist) — EXPAND step only.
-- Lets a second identity issuer (native Workers auth) be added later without a rewrite:
--   auth_provider   which issuer vouches for this account ('firebase' today)
--   email_verified  whether that issuer verified the email (used for payment gating and for safe re-linking)
-- Both have constant defaults, so existing rows are valid immediately (a metadata-only change on PG ≥ 11) and need no
-- backfill pass for NOT NULL. email_verified starts false and is set from the token at each login — a user who has not
-- logged in since this migration is simply "not yet confirmed", which is the safe reading.
-- Rollback: drop the constraint and both columns (no data worth keeping beyond what the next login rewrites).
ALTER TABLE users ADD COLUMN auth_provider  text    NOT NULL DEFAULT 'firebase';
ALTER TABLE users ADD COLUMN email_verified boolean NOT NULL DEFAULT false;

-- NOT VALID then VALIDATE: the validation scan does not hold the long lock the plain ADD would.
ALTER TABLE users ADD CONSTRAINT users_auth_provider_chk CHECK (auth_provider IN ('firebase', 'native')) NOT VALID;
ALTER TABLE users VALIDATE CONSTRAINT users_auth_provider_chk;
