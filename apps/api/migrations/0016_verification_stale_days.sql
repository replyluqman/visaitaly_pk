-- 0016_verification_stale_days: the "Verified N days ago" stamp turns amber once a requirement has gone this long
-- without re-verification (DESIGN-SYSTEM.md, VerifiedStamp). Config default, not content (ADR 0007).
-- `||` keeps any value an admin already set.
UPDATE app_config SET value = '{"stale_days": 30}'::jsonb || value WHERE key = 'verification';
