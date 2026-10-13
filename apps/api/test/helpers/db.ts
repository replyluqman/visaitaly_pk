import pg from 'pg';
import { testDatabaseUrl } from './config.js';

let pool: pg.Pool | undefined;

export function testPool(): pg.Pool {
  pool ??= new pg.Pool({ connectionString: testDatabaseUrl(), max: 4 });
  return pool;
}

export async function closePool(): Promise<void> {
  await pool?.end();
  pool = undefined;
}

/**
 * Wipes user-owned data between tests. Reference/config tables
 * (relationships, app_config) are migration-owned and left alone;
 * legal_versions is test-owned (see seedLegal) and wiped.
 */
export async function resetDb(): Promise<void> {
  await testPool().query(
    'TRUNCATE users, legal_versions RESTART IDENTITY CASCADE',
  );
}

export async function q<T extends Record<string, unknown> = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const r = await testPool().query(text, params);
  return r.rows as T[];
}

export interface SeededLegal {
  disclaimerId: string;
  termsId: string;
}

/** Publishes a current mandatory disclaimer (+ optional terms). Test content only. */
export async function seedLegal(opts: { withTerms?: boolean; version?: string } = {}): Promise<SeededLegal> {
  const version = opts.version ?? '1.0-test';
  const [d] = await q<{ id: string }>(
    `INSERT INTO legal_versions (doc_type, locale, version, title, body_md, is_current, published_at)
     VALUES ('disclaimer','en',$1,'Disclaimer','test body',true,now()) RETURNING id`,
    [version],
  );
  let termsId = '';
  if (opts.withTerms) {
    const [t] = await q<{ id: string }>(
      `INSERT INTO legal_versions (doc_type, locale, version, title, body_md, is_current, published_at)
       VALUES ('terms','en',$1,'Terms','test body',true,now()) RETURNING id`,
      [version],
    );
    termsId = t!.id;
  }
  return { disclaimerId: d!.id, termsId };
}
