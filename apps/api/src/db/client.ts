import { drizzle, type NodePgQueryResultHKT } from 'drizzle-orm/node-postgres';
import type { ExtractTablesWithRelations } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import pg from 'pg';
import * as schema from './schema/index.js';
import type { Env } from '../env.js';

/**
 * Accepts both a connection and a transaction handle.
 *
 * Services are called with `db` at the top level and with `tx` from inside
 * db.transaction(), and both must satisfy the same parameter type — otherwise
 * every service that can participate in a transaction needs a second overload.
 * NodePgDatabase and PgTransaction both extend PgDatabase with these generics,
 * so this is their common supertype.
 *
 * Deliberately excludes `$client`: nothing below the client module should reach
 * for the raw pg connection.
 */
export type Db = PgDatabase<
  NodePgQueryResultHKT,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;

/**
 * One pg Client per request — Workers have no persistent global connection.
 * Hyperdrive does the pooling (PRD §4: mandatory, not optional).
 *
 * Caller MUST hand the returned `close` to ctx.waitUntil so the socket is
 * released after the response is flushed. Not awaiting it inline keeps the
 * connection teardown off the measured request path.
 */
export async function createDb(
  env: Env,
): Promise<{ db: Db; client: pg.Client; close: () => Promise<void> }> {
  const client = new pg.Client({ connectionString: env.HYPERDRIVE.connectionString });
  // pg.Client queues queries but never dials until connect() — without this every
  // query hangs forever (verified against pg 8.x in the Gate 3 harness).
  await client.connect();
  const db = drizzle(client, { schema });
  return {
    db,
    client,
    close: async () => {
      try {
        await client.end();
      } catch {
        // Socket already gone. Nothing actionable; never fail a response on teardown.
      }
    },
  };
}
