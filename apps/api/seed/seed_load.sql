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
