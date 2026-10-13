#!/usr/bin/env node
/**
 * Preflight check. Run before any production deploy:
 *
 *   DATABASE_URL=... node scripts/preflight.mjs --env staging|production
 *
 * A written launch checklist is a checklist someone skips at 2am. These are the
 * conditions that are cheap to verify mechanically and expensive to discover in
 * production, so they are asserted instead of documented.
 *
 * Exits non-zero on any failure so CI can gate on it.
 */
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** `--env staging|production`; defaults to production, the deploy that matters most. */
const envFlag = process.argv.indexOf('--env');
const TARGET_ENV = envFlag > -1 ? process.argv[envFlag + 1] : 'production';
if (!['development', 'staging', 'production'].includes(TARGET_ENV)) {
  console.error(`Unknown --env '${TARGET_ENV}'. Use development | staging | production.`);
  process.exit(1);
}
const failures = [];
const warnings = [];

const fail = (m) => failures.push(m);
const warn = (m) => warnings.push(m);

// ---------------------------------------------------------------------------
// 1. wrangler.toml is fully configured
// ---------------------------------------------------------------------------
/**
 * Lines of wrangler.toml that configure `env`. Top-level tables ([vars],
 * [[hyperdrive]] …) belong to development; `[env.<name>…]` tables to <name>.
 * Bindings are not inherited across environments, so a deploy to staging
 * must not be blocked by development's placeholders, and vice versa.
 */
function sectionFor(toml, env) {
  let owner = 'development';
  const out = [];
  for (const line of toml.split('\n')) {
    const header = line.match(/^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*$/);
    if (header) {
      const m = header[1].match(/^env\.([^.]+)/);
      owner = m ? m[1] : 'development';
    }
    if (owner === env) out.push(line);
  }
  return out.join('\n');
}

async function checkWrangler() {
  const toml = await readFile(join(ROOT, 'wrangler.toml'), 'utf8');
  const scoped = sectionFor(toml, TARGET_ENV);
  if (TARGET_ENV !== 'development' && !scoped.trim()) {
    fail(`wrangler.toml has no [env.${TARGET_ENV}] section.`);
  }
  const placeholders = [...new Set([...scoped.matchAll(/REPLACE_ME[A-Za-z0-9_]*|replace-me-[a-z0-9-]+/g)].map((m) => m[0]))];
  if (placeholders.length) {
    fail(`wrangler.toml [${TARGET_ENV}] still has ${placeholders.length} unset value(s): ${placeholders.join(', ')}`);
  }
  // With this set, Firebase tokens are accepted UNSIGNED (auth bypass). The code
  // also ignores it outside development, but a config that declares it is wrong.
  if (TARGET_ENV !== 'development' && /FIREBASE_AUTH_EMULATOR_HOST/.test(scoped)) {
    fail(`wrangler.toml [${TARGET_ENV}] declares FIREBASE_AUTH_EMULATOR_HOST (unsigned tokens accepted).`);
  }
  // Admin identity (ADR 0012): MFA on, and a Firebase project that is NOT the user project —
  // otherwise a user token would authenticate admin routes.
  if (TARGET_ENV !== 'development') {
    const grab = (k) => scoped.match(new RegExp(`^${k}\\s*=\\s*"([^"]*)"`, 'm'))?.[1];
    if (grab('ADMIN_REQUIRE_MFA') !== 'true') {
      fail(`wrangler.toml [${TARGET_ENV}] must set ADMIN_REQUIRE_MFA = "true".`);
    }
    const user = grab('FIREBASE_PROJECT_ID');
    const admin = grab('ADMIN_FIREBASE_PROJECT_ID');
    if (!admin) fail(`wrangler.toml [${TARGET_ENV}] has no ADMIN_FIREBASE_PROJECT_ID.`);
    else if (admin === user) fail(`ADMIN_FIREBASE_PROJECT_ID equals FIREBASE_PROJECT_ID in [${TARGET_ENV}] — admin must be a separate project.`);
  }
  // A secret in the committed config is the one mistake with no clean recovery:
  // it is in git history the moment it is pushed.
  if (/(?:secret|private_key|password|api_key)\s*=/i.test(toml)) {
    fail('wrangler.toml appears to contain a secret. Use `wrangler secret put` instead.');
  }
}

// ---------------------------------------------------------------------------
// 2. Database state
// ---------------------------------------------------------------------------
async function checkDb(client) {
  // 2a. Every migration on disk is applied.
  const files = (await readdir(join(ROOT, 'migrations')))
    .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
    .map((f) => f.replace(/\.sql$/, ''))
    .sort();

  const { rows: applied } = await client.query('SELECT name FROM schema_migrations');
  const appliedSet = new Set(applied.map((r) => r.name));
  const pending = files.filter((f) => !appliedSet.has(f));
  if (pending.length) fail(`Unapplied migrations: ${pending.join(', ')}`);

  // 2b. No draft legal text is live. This is the guard that lets the dev
  // disclaimer exist at all — see seed/seed_dev_legal.sql.
  const { rows: draft } = await client.query(`
    SELECT doc_type, version FROM legal_versions
     WHERE is_current AND (version ILIKE '%draft%' OR version LIKE '0.%')
  `);
  for (const r of draft) {
    fail(`Placeholder legal text is live: ${r.doc_type} v${r.version}. Publish a reviewed 1.0 via the CMS.`);
  }

  // 2b'. No placeholder requirement content is live (seed/seed_dev_requirements.sql
  // cites a *.invalid source). A published fake requirement is advice to a real family.
  const { rows: fakeReq } = await client.query(`
    SELECT r.code FROM requirements r JOIN sources s ON s.id = r.source_id
     WHERE r.verification_status IN ('published','reviewed')
       AND (s.url ILIKE '%.invalid%' OR r.code LIKE 'dev\\_%')
  `);
  for (const r of fakeReq) fail(`Placeholder requirement is published: ${r.code}. Replace with verified content.`);
  const { rows: pubCount } = await client.query(
    `SELECT count(*)::int AS n FROM requirements WHERE verification_status = 'published'`);
  if (pubCount[0].n === 0) warn('No published requirements — every new case will be empty.');

  // 2b''. Quick Check copy (highest §18 Risk 1 exposure): not a placeholder, no verdict language.
  const rules = JSON.parse(await readFile(join(ROOT, 'copy-rules.json'), 'utf8'));
  const { rows: qc } = await client.query(
    `SELECT version, questions::text || summaries::text || disclaimer::text AS copy
       FROM eligibility_check_versions WHERE is_current`);
  if (qc.length === 0) warn('No current Eligibility Quick Check version published.');
  for (const r of qc) {
    const lower = r.copy.toLowerCase();
    if (r.copy.includes(rules.placeholderMarker)) {
      fail(`Quick Check v${r.version} is placeholder copy. Publish lawyer-reviewed text.`);
    }
    for (const phrase of rules.forbiddenPhrases) {
      if (lower.includes(phrase)) fail(`Quick Check v${r.version} contains forbidden phrase "${phrase}".`);
    }
  }

  // 2c. Every document type the app gates on has a current version. Missing
  // text does not error — it silently deadlocks onboarding at
  // disclaimer_pending, which looks like an app bug, not a content gap.
  const { rows: missing } = await client.query(`
    SELECT d.doc_type FROM (VALUES ('disclaimer'),('terms'),('privacy')) AS d(doc_type)
     WHERE NOT EXISTS (
       SELECT 1 FROM legal_versions lv
        WHERE lv.doc_type = d.doc_type AND lv.is_current
     )
  `);
  for (const r of missing) warn(`No current version published for '${r.doc_type}'.`);

  // 2d. Config keys the API reads should exist rather than falling back.
  // A fallback in production means behaviour depends on whether a row loaded.
  const { rows: cfg } = await client.query(`
    SELECT d.key FROM (VALUES ('auth'),('onboarding'),('nulla_osta'),('checklist'),('uploads'),('today')) AS d(key)
     WHERE NOT EXISTS (SELECT 1 FROM app_config c WHERE c.key = d.key)
  `);
  for (const r of cfg) warn(`app_config['${r.key}'] missing — the API will use its coded fallback.`);

  // 2e. Foreign keys without a covering index (docs/SCALE.md, Gate 4).
  const { rows: fks } = await client.query(`
    SELECT c.conrelid::regclass::text AS tbl, a.attname AS col
      FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
     WHERE c.contype = 'f'
       AND NOT EXISTS (
         SELECT 1 FROM pg_index i
          WHERE i.indrelid = c.conrelid AND i.indkey[0] = c.conkey[1]
       )
  `);
  for (const r of fks) warn(`Foreign key ${r.tbl}.${r.col} has no covering index.`);
}

// ---------------------------------------------------------------------------

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

await checkWrangler();

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  await checkDb(client);
} finally {
  await client.end();
}

for (const w of warnings) console.log(`  WARN   ${w}`);
for (const f of failures) console.log(`  FAIL   ${f}`);

if (failures.length) {
  console.log(`\n${failures.length} blocking issue(s). Not safe to deploy.`);
  process.exit(1);
}
console.log(
  warnings.length
    ? `\nNo blocking issues. ${warnings.length} warning(s) — review before deploying.`
    : '\nAll preflight checks passed.',
);
