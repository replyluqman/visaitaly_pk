#!/usr/bin/env node
/**
 * Proves every migration's .down.sql actually reverses it (CLAUDE.md schema
 * protocol, TESTING.md definition of done). Run against a THROWAWAY database:
 *
 *   DATABASE_URL=postgres://.../vip_ci node scripts/migrate-roundtrip.mjs
 *
 *   1. up      — apply everything, snapshot the schema
 *   2. down×N  — roll back every migration
 *   3. assert  — only schema_migrations remains in `public`
 *   4. up      — re-apply, snapshot again
 *   5. assert  — second snapshot is identical to the first
 *
 * Refuses to run unless the database name ends in _ci or _test, so it can never
 * be pointed at a real environment by accident.
 */
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const MIGRATE = join(dirname(fileURLToPath(import.meta.url)), 'migrate.mjs');
const url = process.env.DATABASE_URL;

if (!url) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}
const dbName = new URL(url).pathname.replace(/^\//, '');
if (!/_(ci|test)$/.test(dbName)) {
  console.error(`Refusing to run against '${dbName}': database name must end in _ci or _test.`);
  process.exit(1);
}

const migrate = (cmd) => execFileSync('node', [MIGRATE, cmd], { stdio: 'inherit', env: process.env });

/** Tables, columns, indexes, constraints and triggers in `public`, as sorted text. */
async function snapshot(client) {
  const q = async (sql) => (await client.query(sql)).rows.map((r) => Object.values(r).join('|'));
  const parts = [
    ...(await q(`SELECT 'col', table_name, column_name, data_type, is_nullable, coalesce(column_default,'')
                   FROM information_schema.columns WHERE table_schema = 'public'`)),
    ...(await q(`SELECT 'idx', indexname, indexdef FROM pg_indexes WHERE schemaname = 'public'`)),
    ...(await q(`SELECT 'con', conrelid::regclass::text, conname, pg_get_constraintdef(oid)
                   FROM pg_constraint WHERE connamespace = 'public'::regnamespace`)),
    ...(await q(`SELECT 'trg', event_object_table, trigger_name, action_timing, event_manipulation
                   FROM information_schema.triggers WHERE trigger_schema = 'public'`)),
  ];
  return parts.sort();
}

const client = new pg.Client({ connectionString: url });
await client.connect();
let failed = false;
try {
  migrate('up');
  const first = await snapshot(client);
  const { rows } = await client.query('SELECT count(*)::int AS n FROM schema_migrations');
  const applied = rows[0].n;
  console.log(`\n▶ applied ${applied} migration(s); rolling all back`);

  for (let i = 0; i < applied; i++) migrate('down');

  const { rows: leftovers } = await client.query(`
    SELECT 'table ' || table_name AS obj FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name <> 'schema_migrations'
    UNION ALL
    SELECT 'function ' || p.proname FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace`);
  if (leftovers.length) {
    failed = true;
    console.error(`\n✗ rollback left objects behind:\n  ${leftovers.map((r) => r.obj).join('\n  ')}`);
  } else {
    console.log('✓ full rollback leaves only schema_migrations');
  }

  migrate('up');
  const second = await snapshot(client);
  const a = new Set(first);
  const b = new Set(second);
  const onlyFirst = first.filter((x) => !b.has(x));
  const onlySecond = second.filter((x) => !a.has(x));
  if (onlyFirst.length || onlySecond.length) {
    failed = true;
    console.error('\n✗ schema after re-apply differs from first apply');
    for (const x of onlyFirst) console.error(`  - ${x}`);
    for (const x of onlySecond) console.error(`  + ${x}`);
  } else {
    console.log(`✓ re-apply reproduces the identical schema (${first.length} objects)`);
  }
} finally {
  await client.end();
}
process.exit(failed ? 1 : 0);
