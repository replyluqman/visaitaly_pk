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
 * legal_versions, requirements and sources are test-owned and wiped.
 */
export async function resetDb(): Promise<void> {
  await testPool().query(
    'TRUNCATE users, legal_versions, requirements, requirement_versions, sources, source_flags, admins, audit_log, notification_templates, data_requests RESTART IDENTITY CASCADE',
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

export interface Catalogue {
  sourceId: string;
  ids: Record<string, string>;
}

interface Req {
  code: string;
  stage: string;
  sort: number;
  spouse?: boolean;
  child?: boolean;
  parent?: boolean;
  locations?: string[];
  minAge?: number;
  maxAge?: number;
  nulla?: string[];
  blocks?: boolean;
  translation?: boolean;
  apostille?: boolean;
  status?: string;
}

/** Ten published requirements spanning every applicability dimension, plus one unpublished draft. */
export const TEST_REQUIREMENTS: Req[] = [
  { code: 'passport', stage: 'eligibility', sort: 10, blocks: true },
  { code: 'nikah', stage: 'documents', sort: 10, child: false, parent: false, blocks: true, translation: true, apostille: true },
  { code: 'birth_cert', stage: 'documents', sort: 20, spouse: false, parent: false, translation: true },
  { code: 'dependency', stage: 'documents', sort: 30, spouse: false, child: false },
  { code: 'italy_only', stage: 'documents', sort: 40, locations: ['italy'] },
  { code: 'adult_only', stage: 'documents', sort: 50, minAge: 18 },
  { code: 'minor_only', stage: 'documents', sort: 60, maxAge: 17 },
  { code: 'after_nulla', stage: 'translation', sort: 10, nulla: ['received'] },
  { code: 'appointment_slot', stage: 'appointment', sort: 10, blocks: true },
  { code: 'visa_form', stage: 'application', sort: 10 },
  { code: 'draft_item', stage: 'documents', sort: 99, status: 'created' },
];

export async function seedCatalogue(reqs: Req[] = TEST_REQUIREMENTS): Promise<Catalogue> {
  const [src] = await q<{ id: string }>(
    `INSERT INTO sources (url, name, authority) VALUES ('https://example.test/src', '{"en":"Test Source"}', 'embassy') RETURNING id`,
  );
  const ids: Record<string, string> = {};
  for (const r of reqs) {
    const published = (r.status ?? 'published') === 'published';
    const [row] = await q<{ id: string }>(
      `INSERT INTO requirements (code, stage, sort_order, title, purpose, na_reason,
         applies_spouse, applies_child, applies_parent, applies_locations, min_age_years, max_age_years,
         requires_nulla_osta_status, blocks_submission, translation_required, apostille_required,
         source_id, source_document, verification_status, last_verified_at)
       VALUES ($1,$2,$3, jsonb_build_object('en',$1::text), '{"en":"why"}', '{"en":"Not for your category."}',
         $4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'p.12',$15, CASE WHEN $15='created' THEN NULL ELSE now() END)
       RETURNING id`,
      [r.code, r.stage, r.sort, r.spouse ?? true, r.child ?? true, r.parent ?? true, r.locations ?? null,
       r.minAge ?? null, r.maxAge ?? null, r.nulla ?? null, r.blocks ?? false, r.translation ?? false,
       r.apostille ?? false, src!.id, published ? 'published' : r.status],
    );
    ids[r.code] = row!.id;
  }
  return { sourceId: src!.id, ids };
}

/** Inserts an already-linked admin directly (the bootstrap path used by scripts/create-super-admin.mjs). */
export async function seedAdmin(
  a: { uid: string; email: string },
  opts: { isSuper?: boolean; scopes?: string[]; status?: string } = {},
): Promise<string> {
  const [row] = await q<{ id: string }>(
    `INSERT INTO admins (firebase_uid, email, is_super, status) VALUES ($1,$2,$3,$4) RETURNING id`,
    [a.uid, a.email, opts.isSuper ?? false, opts.status ?? 'active'],
  );
  for (const scope of opts.scopes ?? []) {
    await q(`INSERT INTO admin_permissions (admin_id, scope) VALUES ($1,$2)`, [row!.id, scope]);
  }
  return row!.id;
}

/** Neutral templates for every notification type the code can emit (test copy, not product copy). */
export async function seedTemplates(except: string[] = []): Promise<void> {
  const types: Record<string, string> = JSON.parse(
    (await import('node:fs')).readFileSync(new URL('../../src/lib/notification-types.json', import.meta.url), 'utf8'),
  );
  for (const type of Object.keys(types).filter((t) => !t.startsWith('_') && !except.includes(t))) {
    await q(
      `INSERT INTO notification_templates (type, locale, title, body) VALUES ($1,'en',$2,$3)
       ON CONFLICT (type, locale) DO UPDATE SET title = EXCLUDED.title, body = EXCLUDED.body`,
      [type, `T:${type}`, `B:${type}|{title}|{changeSummary}|{days}|{date}`],
    );
  }
}
