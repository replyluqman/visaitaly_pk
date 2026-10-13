-- Rollback for 0004. Re-creating the UNIQUE index FAILS if two live rows now share a
-- lower(email). Before rolling back, resolve duplicates, e.g.:
--   SELECT lower(email), count(*) FROM users
--   WHERE email IS NOT NULL AND deleted_at IS NULL GROUP BY 1 HAVING count(*) > 1;
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_uq
  ON users (lower(email))
  WHERE email IS NOT NULL AND deleted_at IS NULL;
