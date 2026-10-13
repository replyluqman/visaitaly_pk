-- seed_dev_legal.sql — DEV ONLY. Never run in production.
--
--   psql "$DATABASE_URL" -f apps/api/seed/seed_dev_legal.sql
--
-- Why this is not a migration: legal text is content. A migration applies to
-- every environment the chain touches, so placeholder wording would reach
-- production automatically and silently satisfy the "current disclaimer
-- exists" check that is supposed to block launch.
--
-- The version string deliberately contains "draft". scripts/preflight.mjs
-- fails a production deploy if any is_current legal version is a draft, so
-- this file cannot leak into launch unnoticed.
--
-- Real 1.0 text is published through the CMS (Screens §44). Publishing 1.0
-- correctly forces every user to re-accept, because acceptance is matched on
-- (doc_type, version).

-- PLACEHOLDER, NOT LAWYER-REVIEWED. Contains only the PRD §18 mandatory
-- statements verbatim so onboarding is not deadlocked in development.
-- MUST be superseded by a real 1.0 via Screens §44 before public launch;
-- publishing 1.0 will correctly force every user to re-accept.
INSERT INTO legal_versions (doc_type, locale, version, title, body_md, is_current, published_at)
VALUES (
  'disclaimer', 'en', '0.1-draft', 'Important information before you continue',
  E'## Not an official authority\n\n'
  'VisaItaly PK is an independent informational and administrative assistance service. '
  'It is not affiliated with, endorsed by, or operated by the Embassy of Italy, the Government of Italy, '
  'or any official visa authority or service provider.\n\n'
  '## Requirements change\n\n'
  'Visa requirements and procedures may change. Users should verify the latest requirements through the '
  'referenced official source before submitting an application.\n\n'
  '## What this service does not provide\n\n'
  'Legal representation. Immigration-law advice. Guaranteed approval. Guaranteed appointment. '
  'Prediction of any decision.\n\n'
  '_Draft placeholder pending legal review (PRD §18)._',
  true, now()
)
ON CONFLICT (doc_type, locale, version) DO NOTHING;

-- Idempotent: re-running must not create a second current disclaimer.
