#!/usr/bin/env node
/**
 * Gate 4 — EXPLAIN (ANALYZE) every hot query against the load-seeded database
 * (docs/TESTING.md). Fails on a Seq Scan over a table with >10k rows, or when
 * execution time exceeds the 50 ms DB budget.
 *
 *   psql "$LOAD_DATABASE_URL" -f seed/seed_load.sql
 *   LOAD_DATABASE_URL=… node scripts/gate4.mjs
 *
 * The SQL below mirrors the services (auth.service loadMeSnapshot / session
 * lookup, applicants.service, legal.service). Update both together.
 */
import pg from 'pg';

const url = process.env.LOAD_DATABASE_URL;
if (!url || !/_(test|ci)$/.test(new URL(url).pathname.slice(1))) {
  console.error('LOAD_DATABASE_URL must point at a *_test or *_ci database.');
  process.exit(1);
}
const BUDGET_MS = Number(process.env.GATE4_BUDGET_MS ?? 50);
const BIG_ROWS = 10_000;

function walk(node, hits) {
  if (node['Node Type'] === 'Seq Scan' && node['Plan Rows'] !== undefined) {
    hits.push({ rel: node['Relation Name'], rows: node['Plan Rows'], actual: node['Actual Rows'] });
  }
  for (const c of node.Plans ?? []) walk(c, hits);
}


const client = new pg.Client({ connectionString: url });
await client.connect();
await client.query('ANALYZE');

const { rows: [u] } = await client.query(`
  SELECT u.id, u.firebase_uid, d.device_id
    FROM users u JOIN devices d ON d.user_id = u.id
   WHERE u.firebase_uid = 'load_12345' LIMIT 1`);
const { rows: [ap] } = await client.query(`SELECT id FROM applicants WHERE user_id = $1 LIMIT 1`, [u.id]);

const ME = `
WITH cfg AS (SELECT (value->>'max_active_devices')::int AS m FROM app_config WHERE key='auth'),
ent AS (
  SELECT COALESCE(array_agg(id) FILTER (WHERE bucket='premium'),'{}') AS p,
         COALESCE(array_agg(id) FILTER (WHERE bucket='grace'),'{}') AS g
    FROM (SELECT id, CASE WHEN premium_status='active' AND (access_until IS NULL OR access_until>now()) THEN 'premium'
                          WHEN premium_status='expired_pending_confirmation' AND (grace_until IS NULL OR grace_until>now()) THEN 'grace'
                          ELSE 'expired' END AS bucket
            FROM applicants WHERE user_id=$1 AND status='active' AND premium_status<>'none') b),
appl AS (SELECT count(*)::int AS total, count(*) FILTER (WHERE current_stage IS NULL)::int AS aw
           FROM applicants WHERE user_id=$1 AND status='active'),
legal AS (SELECT COALESCE(array_agg(DISTINCT v.doc_type),'{}') AS pend FROM legal_versions v
           WHERE v.is_current AND v.is_mandatory AND NOT EXISTS (
             SELECT 1 FROM legal_acceptances a JOIN legal_versions av ON av.id=a.legal_version_id
              WHERE a.user_id=$1 AND av.doc_type=v.doc_type AND av.version=v.version))
SELECT u.id, (SELECT m FROM cfg), (SELECT count(*) FROM devices d WHERE d.user_id=u.id AND d.status='active'),
       (SELECT p FROM ent), (SELECT g FROM ent), (SELECT total FROM appl), (SELECT pend FROM legal)
  FROM users u WHERE u.id=$1`;

const RANKED = `
  SELECT ar.id, ar.applicant_id, r.code, r.stage, r.stage_order, r.sort_order,
         coalesce(r.title->>'en', r.title->>'en') AS title, ar.status, ar.is_applicable, ar.needs_review,
         r.translation_required, r.apostille_required, r.blocks_submission, r.last_verified_at, r.version,
         ar.updated_at, r.updated_at AS requirement_updated_at,
         coalesce(s.name->>'en', s.name->>'en') AS source_name, s.url AS source_url,
         EXISTS (SELECT 1 FROM source_flags f WHERE f.source_id = r.source_id AND f.status = 'open') AS source_under_review,
         row_number() OVER (PARTITION BY ar.is_applicable ORDER BY r.stage_order, r.sort_order, ar.id) AS rn
    FROM applicant_requirements ar JOIN requirements r ON r.id = ar.requirement_id AND r.verification_status = 'published'
    LEFT JOIN sources s ON s.id = r.source_id
   WHERE ar.applicant_id = $1::uuid AND ar.user_id = $2`;
const { rows: [item] } = await client.query(`SELECT id FROM applicant_requirements WHERE applicant_id = $1 LIMIT 1`, [ap.id]);

// Mirrors today.service.refreshNextActions. Runs in the Cron Worker, off the request path, so it
// has its own budget (GATE4_CRON_BUDGET_MS) — but it must still be index-driven.
const REFRESH = `
    WITH batch AS (
      SELECT a.id, a.user_id, a.current_stage, a.nulla_osta_status, a.nulla_osta_expiry_date
        FROM applicants a
        LEFT JOIN next_actions n ON n.applicant_id = a.id
       WHERE a.status = 'active' AND a.case_generated_at IS NOT NULL
       ORDER BY n.computed_at NULLS FIRST, a.id
       LIMIT $1
    ),
    cand AS (
      -- 1a. documents about to expire
      SELECT b.id AS applicant_id, 1 AS kind_rank, 'expiring' AS kind, 'document_expires' AS reason,
             r.title AS title, ar.id AS item_id, d.expiry_date AS due_date, 0 AS sub_rank,
             coalesce(r.stage_order, 0) AS stage_order, coalesce(r.sort_order, 0) AS sort_order
        FROM batch b
        CROSS JOIN LATERAL (
          SELECT d.applicant_requirement_id, d.expiry_date FROM documents d
           WHERE d.applicant_id = b.id AND d.status = 'active' AND d.expiry_date IS NOT NULL
             AND d.expiry_date <= CURRENT_DATE + $2::int
          OFFSET 0
        ) d
        LEFT JOIN applicant_requirements ar ON ar.id = d.applicant_requirement_id
        LEFT JOIN requirements r ON r.id = ar.requirement_id AND r.verification_status = 'published'
      UNION ALL
      -- 1b. Nulla Osta about to expire
      SELECT b.id, 1, 'expiring', 'nulla_osta_expires', NULL::jsonb, NULL::uuid,
             b.nulla_osta_expiry_date, 0, 0, 0
        FROM batch b
       WHERE b.nulla_osta_status = 'received' AND b.nulla_osta_expiry_date IS NOT NULL
         AND b.nulla_osta_expiry_date <= CURRENT_DATE + $2::int
      UNION ALL
      -- 2. blocking submission
      SELECT b.id, 2, 'blocking', 'blocks_submission', r.title, ar.id, NULL::date, 0,
             r.stage_order, r.sort_order
        FROM batch b
        CROSS JOIN LATERAL (
          SELECT ar.id, ar.requirement_id, ar.status FROM applicant_requirements ar
           WHERE ar.applicant_id = b.id AND ar.is_applicable AND ar.status <> 'ready'
          OFFSET 0 -- planner fence: one index probe per batch applicant, never a scan of the table
        ) ar
        JOIN requirements r ON r.id = ar.requirement_id AND r.blocks_submission
                           AND r.verification_status = 'published'
      UNION ALL
      -- 3. to do in the current stage
      SELECT b.id, 3, 'todo',
             CASE ar.status WHEN 'issue_found' THEN 'issue_found' WHEN 'in_progress' THEN 'in_progress'
                            ELSE 'not_started' END,
             r.title, ar.id, NULL::date,
             CASE ar.status WHEN 'issue_found' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END,
             r.stage_order, r.sort_order
        FROM batch b
        CROSS JOIN LATERAL (
          SELECT ar.id, ar.requirement_id, ar.status FROM applicant_requirements ar
           WHERE ar.applicant_id = b.id AND ar.is_applicable AND ar.status <> 'ready'
          OFFSET 0
        ) ar
        JOIN requirements r ON r.id = ar.requirement_id AND r.stage = b.current_stage
                           AND r.verification_status = 'published'
    ),
    best AS (
      -- An item that qualifies twice appears once, at its best rank.
      SELECT DISTINCT ON (applicant_id, coalesce(item_id::text, kind || reason)) *
        FROM cand
       ORDER BY applicant_id, coalesce(item_id::text, kind || reason), kind_rank, sub_rank
    ),
    ranked AS (
      SELECT *, row_number() OVER (
               PARTITION BY applicant_id
               ORDER BY kind_rank, due_date NULLS LAST, sub_rank, stage_order, sort_order, item_id) AS rn
        FROM best
    ),
    agg AS (
      SELECT applicant_id,
             jsonb_agg(jsonb_build_object(
               'kind', kind, 'reason', reason, 'title', title, 'itemId', item_id,
               'dueDate', to_char(due_date, 'YYYY-MM-DD'), 'rank', kind_rank) ORDER BY rn) AS actions
        FROM ranked WHERE rn <= $3
       GROUP BY applicant_id
    )
    INSERT INTO next_actions (applicant_id, user_id, actions, computed_at)
    SELECT b.id, b.user_id, coalesce(agg.actions, '[]'::jsonb), now()
      FROM batch b LEFT JOIN agg ON agg.applicant_id = b.id
    ON CONFLICT (applicant_id) DO UPDATE
       SET actions = EXCLUDED.actions, user_id = EXCLUDED.user_id, computed_at = EXCLUDED.computed_at
`;

const QUERIES = {
  'cms: requirement list (catalogue order)': [`
    SELECT r.id, r.code, r.stage, r.verification_status, r.version, coalesce(r.title->>'en', r.code), r.source_id, r.last_verified_at,
           EXISTS (SELECT 1 FROM source_flags f WHERE f.source_id = r.source_id AND f.status = 'open')
      FROM requirements r WHERE r.verification_status = 'published' ORDER BY r.stage_order, r.sort_order, r.id LIMIT 51`, []],
  'cms: sweep selection': [`SELECT id, url, last_hash FROM sources WHERE is_active ORDER BY last_checked_at NULLS FIRST, id LIMIT 20`, []],
  'cms: verification summary (public)': [`
    SELECT (SELECT count(*) FROM requirements WHERE verification_status = 'published'),
           (SELECT count(*) FROM requirements WHERE verification_status = 'published' AND source_id IS NOT NULL),
           (SELECT max(last_checked_at) FROM sources WHERE is_active), (SELECT count(*) FROM source_flags WHERE status = 'open')`, []],
  'cms: recent updates (public)': [`
    SELECT v.snapshot->'title'->>'en', v.change_summary->>'en', v.effective_date FROM requirement_versions v ORDER BY v.published_at DESC, v.id DESC LIMIT 5`, []],
  'admin: auth lookup + scopes': [`
    SELECT a.id, a.email, a.is_super, a.status, coalesce(array_agg(p.scope) FILTER (WHERE p.scope IS NOT NULL), '{}')
      FROM admins a LEFT JOIN admin_permissions p ON p.admin_id = a.id WHERE a.firebase_uid = 'admin_7' GROUP BY a.id`, []],
  'admin: link by email': [`UPDATE admins SET last_login_at = now() WHERE email = 'admin7@admin.example.com' AND firebase_uid IS NULL AND status='active'`, []],
  'audit: newest page': [`
    SELECT id, actor_type, action, metadata, created_at, created_at::text AS created_at_raw FROM audit_log
     ORDER BY created_at DESC, id DESC LIMIT 51`, []],
  'audit: by target': [`
    SELECT id FROM audit_log WHERE target_type = 'requirement' AND target_id = '42' ORDER BY created_at DESC, id DESC LIMIT 51`, []],
  'audit: by actor (keyset)': [`
    SELECT id FROM audit_log WHERE actor_id = (SELECT id FROM admins WHERE firebase_uid='admin_3')
       AND (created_at, id) < (now(), 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid)
     ORDER BY created_at DESC, id DESC LIMIT 51`, []],
  'audit: rare action': [`SELECT id FROM audit_log WHERE action = 'admin.bootstrap_super' ORDER BY created_at DESC, id DESC LIMIT 51`, []],
  'audit: filter by action only': [`
    SELECT id FROM audit_log WHERE action = 'case.lookup' ORDER BY created_at DESC, id DESC LIMIT 51`, []],
  'documents: list (cursor, newest first)': [`
    SELECT d.id, d.applicant_id, d.mime, d.size_bytes::int, d.created_at FROM documents d
     WHERE d.user_id=$1 AND d.status='active' AND (d.created_at, d.id) < (now(), 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid)
     ORDER BY d.created_at DESC, d.id DESC LIMIT 21`, [u.id]],
  'documents: list for applicant': [`
    SELECT d.id FROM documents d WHERE d.user_id=$1 AND d.status='active' AND d.applicant_id=$2::uuid
     ORDER BY d.created_at DESC, d.id DESC LIMIT 21`, [u.id, ap.id]],
  'documents: quota sum': [`
    SELECT coalesce(sum(size_bytes),0)::bigint FROM documents WHERE user_id=$1
       AND (status='active' OR (status='pending' AND created_at > now() - make_interval(secs => 900)))`, [u.id]],
  'documents: by id (owner)': [`
    SELECT d.id FROM documents d WHERE d.id=(SELECT id FROM documents WHERE user_id=$1 AND status='active' LIMIT 1) AND d.user_id=$1 AND d.status='active'`, [u.id]],
  'documents: count for item (checklist)': [`SELECT count(*)::int FROM documents d WHERE d.applicant_requirement_id=$1::uuid AND d.status='active'`, [item.id]],
  'today: read next_actions': [`
    SELECT a.id, a.current_stage, a.premium_status, n.actions, n.computed_at FROM applicants a
      LEFT JOIN next_actions n ON n.applicant_id = a.id AND n.user_id = a.user_id
     WHERE a.user_id=$1 AND a.status='active' ORDER BY a.created_at`, [u.id]],
  'quick check: current version': [`SELECT version, questions, summaries, disclaimer, whatsapp_url FROM eligibility_check_versions WHERE is_current`, []],
  'quick check: typical items': [`
    SELECT coalesce(r.title->>'en', r.title->>'en'), coalesce(r.purpose->>'en', r.purpose->>'en'), count(*) OVER ()::int
      FROM requirements r
     WHERE r.verification_status='published'
       AND ((CASE 'spouse'::text WHEN 'spouse' THEN r.applies_spouse WHEN 'child' THEN r.applies_child WHEN 'parent' THEN r.applies_parent END)
            AND (r.applies_locations IS NULL OR 'pakistan'::text = ANY (r.applies_locations)))
     ORDER BY r.stage_order, r.sort_order, r.id LIMIT 3`, []],
  'checklist list (free preview, page 1)': [`
    WITH ranked AS (${RANKED})
    SELECT *, now() AS synced_at FROM ranked WHERE (is_applicable AND rn <= 3)
     ORDER BY stage_order, sort_order, id LIMIT 21`, [ap.id, u.id]],
  'checklist list (premium, keyset page 2)': [`
    WITH ranked AS (${RANKED})
    SELECT * FROM ranked WHERE (stage_order, sort_order, id) > (3::smallint, 5::int, '00000000-0000-0000-0000-000000000000'::uuid)
     ORDER BY stage_order, sort_order, id LIMIT 21`, [ap.id, u.id]],
  'checklist delta (since)': [`
    WITH ranked AS (${RANKED})
    SELECT * FROM ranked WHERE (updated_at > now() - interval '1 hour' OR requirement_updated_at > now() - interval '1 hour')
     ORDER BY stage_order, sort_order, id LIMIT 21`, [ap.id, u.id]],
  'checklist locked count': [`SELECT count(*)::int FROM applicant_requirements WHERE applicant_id=$1::uuid AND user_id=$2 AND is_applicable`, [ap.id, u.id]],
  'item ownership lookup': [`SELECT applicant_id FROM applicant_requirements WHERE id=$1::uuid AND user_id=$2`, [item.id, u.id]],
  'item lock for write': [`
    SELECT ar.applicant_id, ar.is_applicable, ar.status_updated_at, rq.version, a.premium_status
      FROM applicant_requirements ar JOIN requirements rq ON rq.id = ar.requirement_id AND rq.verification_status = 'published'
      JOIN applicants a ON a.id = ar.applicant_id AND a.user_id = ar.user_id
     WHERE ar.id=$1::uuid AND ar.user_id=$2 AND a.status='active' FOR UPDATE OF ar`, [item.id, u.id]],
  'item status update': [`UPDATE applicant_requirements SET status='ready', status_updated_at=now() WHERE id=$1::uuid AND user_id=$2`, [item.id, u.id]],
  'journey aggregate': [`
    SELECT r.stage, count(*)::int, count(*) FILTER (WHERE ar.status='ready')::int
      FROM applicant_requirements ar JOIN requirements r ON r.id = ar.requirement_id AND r.verification_status = 'published'
     WHERE ar.applicant_id=$1::uuid AND ar.user_id=$2 AND ar.is_applicable GROUP BY r.stage`, [ap.id, u.id]],
  'case generation (INSERT…SELECT, conflict path)': [`
    INSERT INTO applicant_requirements (user_id, applicant_id, requirement_id, is_applicable, seen_requirement_version)
    SELECT a.user_id, a.id, r.id, true, r.version FROM applicants a CROSS JOIN requirements r
     WHERE a.id=$1::uuid AND r.verification_status='published'
    ON CONFLICT (applicant_id, requirement_id) DO UPDATE SET is_applicable = EXCLUDED.is_applicable
      WHERE applicant_requirements.is_applicable IS DISTINCT FROM EXCLUDED.is_applicable`, [ap.id]],
  'readiness lateral (applicants list)': [`
    SELECT a.id, rd.applicable, rd.ready FROM applicants a
      LEFT JOIN LATERAL (
        SELECT count(*) FILTER (WHERE ar.is_applicable)::int AS applicable,
               count(*) FILTER (WHERE ar.is_applicable AND ar.status='ready')::int AS ready,
               count(*) FILTER (WHERE ar.is_applicable AND rq.blocks_submission AND ar.status <> 'ready')::int AS blocking
          FROM applicant_requirements ar JOIN requirements rq ON rq.id = ar.requirement_id AND rq.verification_status = 'published'
         WHERE ar.applicant_id = a.id AND ar.user_id = a.user_id) rd ON true
     WHERE a.user_id=$1 AND a.status='active' ORDER BY a.created_at`, [u.id]],
  'session lookup (requireSession)': [`
    SELECT u.id, u.status, d.status FROM users u
      LEFT JOIN devices d ON d.user_id=u.id AND d.device_id=$2::uuid
     WHERE u.firebase_uid=$1`, [u.firebase_uid, u.device_id]],
  'login upsert user': [`
    INSERT INTO users (firebase_uid,email,display_name,last_login_at) VALUES ($1,'x@example.com','n',now())
    ON CONFLICT (firebase_uid) DO UPDATE SET last_login_at=now() WHERE users.status='active' RETURNING id`, [u.firebase_uid]],
  'evict overflow devices': [`
    UPDATE devices SET status='evicted' WHERE user_id=$1 AND status='active'
      AND id NOT IN (SELECT id FROM devices WHERE user_id=$1 AND status='active' ORDER BY last_login_at DESC, id DESC LIMIT 2)`, [u.id]],
  'GET /v1/me snapshot': [ME, [u.id]],
  'touch device last_seen': [`UPDATE devices SET last_seen_at=now() WHERE user_id=$1 AND device_id=$2::uuid`, [u.id, u.device_id]],
  'GET /v1/devices': [`
    SELECT device_id, platform, model, app_version, last_login_at, last_seen_at FROM devices
     WHERE user_id=$1 AND status='active' ORDER BY last_login_at DESC`, [u.id]],
  'GET /v1/applicants (list)': [`
    SELECT a.id, a.display_name, a.relationship_code, coalesce(r.labels->>'en', r.labels->>'en')
      FROM applicants a JOIN relationships r ON r.code=a.relationship_code
     WHERE a.user_id=$1 AND a.status='active' ORDER BY a.created_at`, [u.id]],
  'GET /v1/applicants/:id': [`
    SELECT a.id FROM applicants a JOIN relationships r ON r.code=a.relationship_code
     WHERE a.id=$1::uuid AND a.user_id=$2 AND a.status='active'`, [ap.id, u.id]],
  'applicant FOR UPDATE': [`SELECT id FROM applicants WHERE id=$1::uuid AND user_id=$2 AND status='active' FOR UPDATE`, [ap.id, u.id]],
  'applicant count (create gate)': [`SELECT count(*) FROM applicants a WHERE a.user_id=$1 AND a.status='active'`, [u.id]],
  'onboarding recompute counts': [`
    SELECT count(*), count(*) FILTER (WHERE current_stage IS NULL) FROM applicants WHERE user_id=$1 AND status='active'`, [u.id]],
  'legal current list': [`
    SELECT DISTINCT ON (v.doc_type) v.id FROM legal_versions v
     WHERE v.is_current AND v.locale IN ('en','en') ORDER BY v.doc_type, (v.locale='en') DESC`, []],
  'legal accepted check': [`
    SELECT EXISTS (SELECT 1 FROM legal_acceptances a JOIN legal_versions av ON av.id=a.legal_version_id
                    WHERE a.user_id=$1 AND av.doc_type='disclaimer' AND av.version='load-draft')`, [u.id]],
};


let failed = false;

// Admin publish fan-out: one set-based INSERT … ON CONFLICT across EVERY applicant. Runs on an admin
// request (rare), so it has its own budget; it is inherently a scan of `applicants`.
{
  await client.query('BEGIN');
  try {
    const budget = Number(process.env.GATE4_FANOUT_BUDGET_MS ?? 15000);
    const { rows } = await client.query(`
      EXPLAIN (ANALYZE, FORMAT JSON)
      INSERT INTO applicant_requirements (user_id, applicant_id, requirement_id, is_applicable, seen_requirement_version)
      SELECT a.user_id, a.id, r.id,
             (CASE a.relationship_category WHEN 'spouse' THEN r.applies_spouse WHEN 'child' THEN r.applies_child WHEN 'parent' THEN r.applies_parent END)
             AND (r.applies_locations IS NULL OR a.current_location IS NULL OR a.current_location = ANY (r.applies_locations)),
             r.version
        FROM applicants a CROSS JOIN requirements r
       WHERE r.code = 'load_1' AND r.verification_status = 'published' AND a.status = 'active' AND a.case_generated_at IS NOT NULL
      ON CONFLICT (applicant_id, requirement_id) DO UPDATE SET is_applicable = EXCLUDED.is_applicable
        WHERE applicant_requirements.is_applicable IS DISTINCT FROM EXCLUDED.is_applicable`);
    const ms = rows[0]['QUERY PLAN'][0]['Execution Time'];
    const ok = ms <= budget;
    if (!ok) failed = true;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${ms.toFixed(0).padStart(7)} ms  [admin] publish fan-out across all 75,000 applicants (re-publish, no-op conflict path)`);
  } finally {
    await client.query('ROLLBACK');
  }
}

// Cron statement: measured separately, then dropped from the request-path loop below.
{
  await client.query('BEGIN');
  try {
    const CRON_BUDGET_MS = Number(process.env.GATE4_CRON_BUDGET_MS ?? 5000);
    const { rows } = await client.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${REFRESH}`, [Number(process.env.GATE4_BATCH ?? 15000), 30, 5]);
    const plan = rows[0]['QUERY PLAN'][0];
    const ms = plan['Execution Time'];
    const seq = [];
    walk(plan.Plan, seq);
    const { rows: sizes } = await client.query(
      `SELECT relname, reltuples::bigint AS n FROM pg_class WHERE relname = ANY($1)`, [seq.map((s) => s.rel)]);
    // The batch scan of applicants is inherently a scan (it picks the stalest N of all); everything
    // else must use an index, in particular the 1.9M-row applicant_requirements and documents.
    const bigSeq = seq.filter((s) => s.rel !== 'applicants' && s.rel !== 'next_actions'
      && (sizes.find((z) => z.relname === s.rel)?.n ?? 0) > BIG_ROWS);
    const ok = bigSeq.length === 0 && ms <= CRON_BUDGET_MS;
    if (!ok) failed = true;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${ms.toFixed(0).padStart(7)} ms  [cron] refresh next_actions, batch ${process.env.GATE4_BATCH ?? 15000}${bigSeq.length ? `  SEQ SCAN ${bigSeq.map((s) => s.rel)}` : ''}`);
  } finally {
    await client.query('ROLLBACK');
  }
}
const { rows: counts } = await client.query(
  `SELECT (SELECT count(*) FROM users) u, (SELECT count(*) FROM applicants) a, (SELECT count(*) FROM devices) d, (SELECT count(*) FROM applicant_requirements) ar`);
console.log(`volume: users=${counts[0].u} applicants=${counts[0].a} devices=${counts[0].d} applicant_requirements=${counts[0].ar}\n`);

for (const [name, [text, params]] of Object.entries(QUERIES)) {
  await client.query('BEGIN');
  try {
    // Warm once, measure the second run (plan + cache), roll back so writes leave no trace.
    await client.query(text, params);
    const { rows } = await client.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${text}`, params);
    const plan = rows[0]['QUERY PLAN'][0];
    const ms = plan['Execution Time'];
    const seq = [];
    walk(plan.Plan, seq);
    const { rows: sizes } = await client.query(
      `SELECT relname, reltuples::bigint AS n FROM pg_class WHERE relname = ANY($1)`, [seq.map((s) => s.rel)]);
    const bigSeq = seq.filter((s) => (sizes.find((z) => z.relname === s.rel)?.n ?? 0) > BIG_ROWS);
    const ok = bigSeq.length === 0 && ms <= BUDGET_MS;
    if (!ok) failed = true;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${ms.toFixed(2).padStart(7)} ms  ${name}${bigSeq.length ? `  SEQ SCAN ${bigSeq.map((s) => s.rel)}` : ''}`);
  } finally {
    await client.query('ROLLBACK');
  }
}
await client.end();
process.exit(failed ? 1 : 0);
