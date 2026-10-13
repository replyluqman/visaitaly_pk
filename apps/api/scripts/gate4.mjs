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

const QUERIES = {
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

function walk(node, hits) {
  if (node['Node Type'] === 'Seq Scan' && node['Plan Rows'] !== undefined) {
    hits.push({ rel: node['Relation Name'], rows: node['Plan Rows'], actual: node['Actual Rows'] });
  }
  for (const c of node.Plans ?? []) walk(c, hits);
}

let failed = false;
const { rows: counts } = await client.query(
  `SELECT (SELECT count(*) FROM users) u, (SELECT count(*) FROM applicants) a, (SELECT count(*) FROM devices) d`);
console.log(`volume: users=${counts[0].u} applicants=${counts[0].a} devices=${counts[0].d}\n`);

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
