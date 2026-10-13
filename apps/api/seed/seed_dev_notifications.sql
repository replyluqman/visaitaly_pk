-- seed_dev_notifications.sql — DEV ONLY. Never run in production.
--
--   psql "$DATABASE_URL" -f apps/api/seed/seed_dev_notifications.sql
--
-- Structure-only placeholder wording for every notification type (src/lib/notification-types.json).
-- The real wording is user-facing copy for the lawyer review (PRD §18) and is entered through the CMS.
-- Every string carries the marker below, so `pnpm preflight` fails a deploy whose templates contain it,
-- or any phrase from copy-rules.json. Placeholders: {title} {changeSummary} {days} {date}.
INSERT INTO notification_templates (type, locale, title, body) VALUES
  ('requirement_added',          'en', '[DEV PLACEHOLDER] A requirement was added',      '[DEV PLACEHOLDER] {title} now applies to your case.'),
  ('requirement_changed',        'en', '[DEV PLACEHOLDER] A requirement changed',        '[DEV PLACEHOLDER] {title}: {changeSummary}'),
  ('nulla_osta_expiring',        'en', '[DEV PLACEHOLDER] Nulla Osta expiry',            '[DEV PLACEHOLDER] {days} days left (until {date}).'),
  ('document_expiring',          'en', '[DEV PLACEHOLDER] A document is expiring',       '[DEV PLACEHOLDER] {title} expires on {date} ({days} days).'),
  ('document_expiring_unlinked', 'en', '[DEV PLACEHOLDER] A document is expiring',       '[DEV PLACEHOLDER] A document expires on {date} ({days} days).')
ON CONFLICT (type, locale) DO NOTHING;
