#!/usr/bin/env node
/**
 * Bootstraps the FIRST super admin (ADR 0012). There is deliberately no API path that creates one:
 * every other admin is pre-registered by a super admin through /v1/admin/admins.
 *
 *   DATABASE_URL=<direct Neon url> node scripts/create-super-admin.mjs owner@company.com
 *
 * The row has no firebase_uid; the person links it by signing in to the ADMIN Firebase project
 * with that (verified) email. Idempotent: re-running for an existing admin only promotes it.
 */
import pg from 'pg';

const email = process.argv[2]?.trim().toLowerCase();
if (!email || !/^[^@\s]+@[^@\s]+$/.test(email)) {
  console.error('usage: node scripts/create-super-admin.mjs <email>');
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set (use the direct Neon URL, not Hyperdrive).');
  process.exit(1);
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  await client.query('BEGIN');
  const { rows } = await client.query(
    `INSERT INTO admins (email, is_super) VALUES ($1, true)
     ON CONFLICT (email) DO UPDATE SET is_super = true, status = 'active'
     RETURNING id, firebase_uid`,
    [email],
  );
  await client.query(
    `INSERT INTO audit_log (actor_type, action, target_type, target_id, metadata)
     VALUES ('system', 'admin.bootstrap_super', 'admin', $1, '{"via":"scripts/create-super-admin.mjs"}')`,
    [rows[0].id],
  );
  await client.query('COMMIT');
  console.log(`super admin ready: ${email} (${rows[0].firebase_uid ? 'already linked' : 'will link on first sign-in'})`);
} catch (err) {
  await client.query('ROLLBACK');
  throw err;
} finally {
  await client.end();
}
