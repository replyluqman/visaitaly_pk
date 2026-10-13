#!/usr/bin/env node
/**
 * Migration runner.
 *
 * Deliberately not Drizzle Kit: the schema files are hand-written SQL because
 * partial indexes, CHECK constraints and data backfills need to be reviewed as
 * SQL, not generated from a diff. This runner only applies what is in
 * migrations/ and records what it applied.
 *
 *   node scripts/migrate.mjs up          apply all pending
 *   node scripts/migrate.mjs down        roll back the most recent one
 *   node scripts/migrate.mjs status      list applied / pending
 *
 * Connects with DATABASE_URL — a direct Neon connection string, NOT Hyperdrive.
 * Hyperdrive is a runtime read path for the Worker; migrations are DDL run from
 * a developer machine or CI.
 */
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import pg from 'pg';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set. Use a direct Neon connection string, not Hyperdrive.');
  process.exit(1);
}

/** Migration files are `NNNN_name.sql`; `NNNN_name.down.sql` is its rollback. */
async function listMigrations() {
  const files = await readdir(MIGRATIONS_DIR);
  return files
    .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
    .sort()
    .map((f) => ({
      name: f.replace(/\.sql$/, ''),
      up: join(MIGRATIONS_DIR, f),
      down: join(MIGRATIONS_DIR, f.replace(/\.sql$/, '.down.sql')),
    }));
}

async function ensureTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name        text PRIMARY KEY,
      checksum    text NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now()
    )
  `);
}

const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);

async function applied(client) {
  const { rows } = await client.query('SELECT name, checksum FROM schema_migrations ORDER BY name');
  return new Map(rows.map((r) => [r.name, r.checksum]));
}

async function up(client) {
  const migrations = await listMigrations();
  const done = await applied(client);
  let ran = 0;

  for (const m of migrations) {
    const sql = await readFile(m.up, 'utf8');
    const checksum = sha(sql);
    const prev = done.get(m.name);

    if (prev !== undefined) {
      // An applied migration that no longer matches means someone edited
      // history. Every environment is now divergent — refuse rather than guess.
      if (prev !== checksum) {
        console.error(
          `\n${m.name} was already applied but its contents changed.\n` +
            `Never edit an applied migration — add a new one instead.\n`,
        );
        process.exit(1);
      }
      continue;
    }

    process.stdout.write(`applying ${m.name} ... `);
    // Each migration is one transaction: it lands whole or not at all.
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [
        m.name,
        checksum,
      ]);
      await client.query('COMMIT');
      console.log('ok');
      ran++;
    } catch (e) {
      await client.query('ROLLBACK');
      console.log('FAILED');
      throw e;
    }
  }

  console.log(ran ? `\n${ran} migration(s) applied.` : 'Already up to date.');
}

async function down(client) {
  const { rows } = await client.query(
    'SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 1',
  );
  const last = rows[0]?.name;
  if (!last) return console.log('Nothing to roll back.');

  const m = (await listMigrations()).find((x) => x.name === last);
  if (!m) {
    console.error(`${last} is recorded as applied but its file is missing.`);
    process.exit(1);
  }

  let sql;
  try {
    sql = await readFile(m.down, 'utf8');
  } catch {
    console.error(`No rollback file for ${last}. Every migration must ship one.`);
    process.exit(1);
  }

  process.stdout.write(`rolling back ${last} ... `);
  await client.query('BEGIN');
  try {
    await client.query(sql);
    await client.query('DELETE FROM schema_migrations WHERE name = $1', [last]);
    await client.query('COMMIT');
    console.log('ok');
  } catch (e) {
    await client.query('ROLLBACK');
    console.log('FAILED');
    throw e;
  }
}

async function status(client) {
  const migrations = await listMigrations();
  const done = await applied(client);
  for (const m of migrations) {
    console.log(`${done.has(m.name) ? '  applied' : '  PENDING'}  ${m.name}`);
  }
}

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  await ensureTable(client);
  const cmd = process.argv[2] ?? 'up';
  if (cmd === 'up') await up(client);
  else if (cmd === 'down') await down(client);
  else if (cmd === 'status') await status(client);
  else {
    console.error(`Unknown command: ${cmd}. Use up | down | status.`);
    process.exit(1);
  }
} finally {
  await client.end();
}
