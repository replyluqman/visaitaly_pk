-- 0006_eligibility_check  (Module 3c — public Eligibility Quick Check, PRD §11, Screens §2)
--
-- EXPAND-ONLY: one new table. Rollback is a plain DROP.
-- NO CONTENT HERE (ADR 0007): questions, summaries and the disclaimer are lawyer-reviewed
-- user-facing copy (PRD §18 Risk 1 — highest exposure surface). Dev placeholder lives in
-- seed/seed_dev_eligibility.sql; `pnpm preflight` blocks a deploy that publishes it.
--
-- Retention: versions are kept forever (small, and they are the record of what copy was live).
CREATE TABLE eligibility_check_versions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version      integer     NOT NULL,
  -- [{id, text:{en}, mapsTo, options:[{value, label:{en}}]}]
  --   mapsTo ∈ relationship_category | current_location | nulla_osta_status
  questions    jsonb       NOT NULL,
  -- {spouse:{en}, child:{en}, parent:{en}} — orientation wording, never a verdict
  summaries    jsonb       NOT NULL,
  disclaimer   jsonb       NOT NULL,
  -- wa.me deep link; NULL until the business number exists (PRD §24 open item)
  whatsapp_url text,
  is_current   boolean     NOT NULL DEFAULT false,
  published_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT eligibility_versions_version_chk CHECK (version >= 1),
  CONSTRAINT eligibility_versions_questions_chk CHECK (
    jsonb_typeof(questions) = 'array' AND jsonb_array_length(questions) BETWEEN 1 AND 6),
  CONSTRAINT eligibility_versions_whatsapp_chk CHECK (
    whatsapp_url IS NULL OR whatsapp_url LIKE 'https://wa.me/%'),
  CONSTRAINT eligibility_versions_current_published_chk CHECK (NOT is_current OR published_at IS NOT NULL)
);

CREATE UNIQUE INDEX eligibility_versions_version_uq ON eligibility_check_versions (version);
-- At most one current version; also the lookup for GET/POST (WHERE is_current).
CREATE UNIQUE INDEX eligibility_versions_current_uq ON eligibility_check_versions (is_current) WHERE is_current;
