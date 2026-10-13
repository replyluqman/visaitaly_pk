-- seed_dev_eligibility.sql — DEV ONLY. Never run in production.
--
--   psql "$DATABASE_URL" -f apps/api/seed/seed_dev_eligibility.sql
--
-- Structure-only placeholder so the Quick Check works locally. The real questions, summaries
-- and disclaimer are lawyer-reviewed user-facing copy (PRD §18 Risk 1) and are published
-- through the CMS. Every string carries the marker below; `pnpm preflight` fails a deploy
-- whose current version contains it, or any phrase from copy-rules.json.
INSERT INTO eligibility_check_versions (version, questions, summaries, disclaimer, is_current, published_at)
VALUES (
  1,
  '[
    {"id":"who","mapsTo":"relationship_category","text":{"en":"[DEV PLACEHOLDER] Who is the application for?"},
     "options":[{"value":"spouse","label":{"en":"[DEV PLACEHOLDER] Spouse"}},
                {"value":"child","label":{"en":"[DEV PLACEHOLDER] Child"}},
                {"value":"parent","label":{"en":"[DEV PLACEHOLDER] Parent"}}]},
    {"id":"where","mapsTo":"current_location","text":{"en":"[DEV PLACEHOLDER] Where are they now?"},
     "options":[{"value":"pakistan","label":{"en":"[DEV PLACEHOLDER] Pakistan"}},
                {"value":"italy","label":{"en":"[DEV PLACEHOLDER] Italy"}},
                {"value":"other","label":{"en":"[DEV PLACEHOLDER] Elsewhere"}}]}
  ]'::jsonb,
  '{"spouse":{"en":"[DEV PLACEHOLDER] Spouse applications typically involve these kinds of documents."},
    "child":{"en":"[DEV PLACEHOLDER] Child applications typically involve these kinds of documents."},
    "parent":{"en":"[DEV PLACEHOLDER] Parent applications typically involve these kinds of documents."}}'::jsonb,
  '{"en":"[DEV PLACEHOLDER] Orientation only — not an eligibility determination."}'::jsonb,
  true, now()
)
ON CONFLICT (version) DO NOTHING;
