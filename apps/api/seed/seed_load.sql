-- seed_load.sql — LOAD-TEST ONLY (docs/TESTING.md Gate 4). Never run in production.
-- Targets: users 30,000 · applicants 75,000 · devices ~60,000. Run against a
-- throwaway *_test / *_ci database after `pnpm migrate`:
--   psql "$LOAD_DATABASE_URL" -f apps/api/seed/seed_load.sql && ANALYZE;
TRUNCATE users, legal_versions RESTART IDENTITY CASCADE;

INSERT INTO legal_versions (doc_type, locale, version, title, body_md, is_current, published_at)
VALUES ('disclaimer','en','load-draft','t','b',true,now()),
       ('terms','en','load-draft','t','b',true,now());

INSERT INTO users (firebase_uid, email, display_name, onboarding_state, declared_applicant_count)
SELECT 'load_' || g, 'u' || g || '@example.com', 'User ' || g, 'complete', 3
  FROM generate_series(1, 30000) g;

INSERT INTO devices (user_id, device_id, platform, app_version, status, last_login_at, last_seen_at)
SELECT u.id, gen_random_uuid(), 'android', '1.0.0',
       CASE WHEN d = 1 THEN 'active' ELSE 'active' END, now() - (d || ' hours')::interval, now()
  FROM users u CROSS JOIN generate_series(1, 2) d;

-- 75,000 applicants: users get 2 or 3 (first 15,000 users get 3).
INSERT INTO applicants (user_id, display_name, relationship_code, relationship_category,
                        current_location, current_stage, stage_updated_at, premium_status, access_until)
SELECT u.id, 'Applicant ' || n, r.code, r.category, 'pakistan',
       (ARRAY['eligibility','nulla_osta','documents','translation','appointment','application','processing','decision'])[1 + (n % 8)],
       now(),
       CASE WHEN n % 5 = 0 THEN 'active' ELSE 'none' END,
       CASE WHEN n % 5 = 0 THEN now() + interval '60 days' END
  FROM (SELECT id, row_number() OVER () AS rn FROM users) u
  JOIN LATERAL generate_series(1, CASE WHEN u.rn <= 15000 THEN 3 ELSE 2 END) n ON true
  JOIN LATERAL (SELECT code, category FROM relationships ORDER BY sort_order OFFSET (n % 6) LIMIT 1) r ON true;

INSERT INTO legal_acceptances (user_id, legal_version_id)
SELECT u.id, v.id FROM users u CROSS JOIN legal_versions v;

-- Module 3: a 25-requirement catalogue, instantiated for every applicant (~1.9M rows).
TRUNCATE requirements, sources RESTART IDENTITY CASCADE;
INSERT INTO sources (url, name, authority) VALUES ('https://load.invalid/src', '{"en":"Load source"}', 'embassy');
INSERT INTO requirements (code, stage, sort_order, title, applies_spouse, applies_child, applies_parent,
                          blocks_submission, source_id, verification_status, last_verified_at)
SELECT 'load_' || g,
       (ARRAY['eligibility','nulla_osta','documents','translation','appointment','application','processing','decision'])[1 + (g % 8)],
       g, jsonb_build_object('en', 'Requirement ' || g),
       g % 3 <> 1, g % 3 <> 2, g % 3 <> 0, g % 4 = 0,
       (SELECT id FROM sources LIMIT 1), 'published', now()
  FROM generate_series(1, 25) g;

INSERT INTO applicant_requirements (user_id, applicant_id, requirement_id, is_applicable, seen_requirement_version, status)
SELECT a.user_id, a.id, r.id,
       CASE a.relationship_category WHEN 'spouse' THEN r.applies_spouse WHEN 'child' THEN r.applies_child ELSE r.applies_parent END,
       r.version, (ARRAY['not_started','in_progress','ready','issue_found'])[1 + (r.sort_order % 4)]
  FROM applicants a CROSS JOIN requirements r;
UPDATE applicants SET case_generated_at = now();
