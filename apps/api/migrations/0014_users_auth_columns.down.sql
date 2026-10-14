-- Rollback for 0014. email_verified is rewritten from the token at the next login; auth_provider is 'firebase' for every row today.
-- Once any account is 'native' this rollback would lose which issuer it belongs to — do not roll back past the cutover.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_auth_provider_chk;
ALTER TABLE users DROP COLUMN IF EXISTS email_verified;
ALTER TABLE users DROP COLUMN IF EXISTS auth_provider;
