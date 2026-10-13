-- 0004_drop_email_unique
-- Identity is users.firebase_uid, not email. Re-signup after a Firebase account
-- deletion yields a new uid with the same email; the partial unique index made that
-- login fail with 500 (DATA-MODEL.md risk 1). Dropping a unique index is a relaxing,
-- non-breaking change. No query filters or sorts on lower(email), so nothing replaces it.
DROP INDEX IF EXISTS users_email_lower_uq;
