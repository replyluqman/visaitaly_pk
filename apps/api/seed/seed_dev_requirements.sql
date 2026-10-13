-- seed_dev_requirements.sql — DEV ONLY. Never run in production.
--
--   psql "$DATABASE_URL" -f apps/api/seed/seed_dev_requirements.sql
--
-- Placeholder structure so the checklist engine has something to instantiate locally.
-- NOT real visa requirements: codes start with `dev_`, titles say so, and the source is
-- https://dev.invalid/… so `pnpm preflight` fails a deploy if any of it is published
-- (ADR 0007). Real, verified content goes in through the CMS (Module 4) or
-- docs/content/requirements.template.csv.
INSERT INTO sources (url, name, authority)
VALUES ('https://dev.invalid/placeholder', '{"en":"DEV placeholder source"}', 'embassy')
ON CONFLICT (url) DO NOTHING;

WITH s AS (SELECT id FROM sources WHERE url = 'https://dev.invalid/placeholder')
INSERT INTO requirements
  (code, stage, sort_order, title, purpose, na_reason, applies_spouse, applies_child, applies_parent,
   blocks_submission, translation_required, source_id, verification_status, last_verified_at)
SELECT v.code, v.stage, v.sort_order,
       jsonb_build_object('en', '[DEV PLACEHOLDER] ' || v.title),
       '{"en":"Placeholder purpose."}'::jsonb,
       '{"en":"Not applicable to your category (placeholder)."}'::jsonb,
       v.sp, v.ch, v.pa, v.blocks, v.tr, s.id, 'published', now()
  FROM s, (VALUES
    ('dev_passport',      'eligibility', 10, 'Passport copy',          true,  true,  true,  true,  false),
    ('dev_marriage_cert', 'documents',   10, 'Marriage certificate',   true,  false, false, true,  true),
    ('dev_birth_cert',    'documents',   20, 'Birth certificate',      false, true,  false, true,  true),
    ('dev_dependency',    'documents',   30, 'Dependency proof',       false, false, true,  false, false),
    ('dev_photos',        'documents',   40, 'Passport photos',        true,  true,  true,  false, false),
    ('dev_translation',   'translation', 10, 'Certified translation',  true,  true,  true,  false, true),
    ('dev_appointment',   'appointment', 10, 'Appointment confirmation', true, true,  true,  true,  false),
    ('dev_application',   'application', 10, 'Visa application form',  true,  true,  true,  true,  false)
  ) AS v(code, stage, sort_order, title, sp, ch, pa, blocks, tr)
ON CONFLICT (code) DO NOTHING;
