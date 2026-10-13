import { createHash } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import type {
  AdminRequirement,
  AdminRequirementSummary,
  AdminSource,
  CmsListQuery,
  CreateRequirementInput,
  CreateSourceInput,
  Page,
  PatchRequirementInput,
  PatchSourceInput,
  RequirementActionInput,
  RequirementListQuery,
  RequirementStatus,
  RequirementVersionEntry,
  ResolveFlagInput,
  SourceFlag,
  VerificationSummary,
} from '@visaitaly/shared';
import type { Db } from '../../db/client.js';
import type { AdminContext } from '../../env.js';
import { AppError } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { decodeTsCursor, encodeTsCursor } from '../../lib/cursor.js';
import { VERIFICATION_CONFIG_FALLBACK, readConfig } from '../../lib/app-config.js';
import { requirementApplies } from '../checklist/applicability.js';

const iso = (v: string | null) => (v ? new Date(v).toISOString() : null);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// fan-out: make every affected applicant's case match the catalogue
// ---------------------------------------------------------------------------

/**
 * Called inside the publish / re-publish transaction. One set-based statement over every active
 * applicant that already has a case:
 *   - a newly published requirement gets a row per applicant (this is the fan-out Module 3 left
 *     to the CMS: without it a requirement published after a case was generated would never appear),
 *   - a re-published one has `is_applicable` recomputed against the new rules.
 * User progress (`status`, `needs_review`) is never touched. `seen_requirement_version` is left
 * alone on existing rows so an offline mutation made against the old version is detected as a conflict.
 */
export async function reconcileRequirement(tx: Db, requirementId: string): Promise<number> {
  const r = await tx.execute(sql`
    INSERT INTO applicant_requirements
           (user_id, applicant_id, requirement_id, is_applicable, seen_requirement_version)
    SELECT a.user_id, a.id, r.id,
           ${requirementApplies({
             category: sql`a.relationship_category`,
             location: sql`a.current_location`,
             nullaOstaStatus: sql`a.nulla_osta_status`,
             dateOfBirth: sql`a.date_of_birth`,
           })},
           r.version
      FROM applicants a
     CROSS JOIN requirements r
     WHERE r.id = ${requirementId}::uuid AND r.verification_status = 'published'
       AND a.status = 'active' AND a.case_generated_at IS NOT NULL
    ON CONFLICT (applicant_id, requirement_id) DO UPDATE
       SET is_applicable = EXCLUDED.is_applicable
     WHERE applicant_requirements.is_applicable IS DISTINCT FROM EXCLUDED.is_applicable
  `);
  return r.rowCount ?? 0;
}

// ---------------------------------------------------------------------------
// row mapping
// ---------------------------------------------------------------------------

type ReqRow = {
  id: string; code: string; stage: string; verification_status: RequirementStatus; version: number;
  title: Record<string, string>; purpose: Record<string, string> | null;
  who_provides: Record<string, string> | null; where_to_obtain: Record<string, string> | null;
  recommended_timing: Record<string, string> | null; condition_note: Record<string, string> | null;
  na_reason: Record<string, string> | null;
  applies_spouse: boolean; applies_child: boolean; applies_parent: boolean;
  applies_locations: string[] | null; min_age_years: number | null; max_age_years: number | null;
  requires_nulla_osta_status: string[] | null; is_conditional: boolean; translation_required: boolean;
  apostille_required: boolean; blocks_submission: boolean; validity_days: number | null;
  source_id: string | null; source_document: string | null; source_published_at: string | null;
  sort_order: number; last_verified_at: string | null; last_verified_by: string | null;
  created_at: string; updated_at: string;
};

const REQ_COLUMNS = sql`
  r.id, r.code, r.stage, r.verification_status, r.version, r.title, r.purpose, r.who_provides,
  r.where_to_obtain, r.recommended_timing, r.condition_note, r.na_reason, r.applies_spouse,
  r.applies_child, r.applies_parent, r.applies_locations, r.min_age_years, r.max_age_years,
  r.requires_nulla_osta_status, r.is_conditional, r.translation_required, r.apostille_required,
  r.blocks_submission, r.validity_days, r.source_id, r.source_document,
  to_char(r.source_published_at, 'YYYY-MM-DD') AS source_published_at, r.sort_order,
  r.last_verified_at, r.last_verified_by, r.created_at, r.updated_at
`;

const toRequirement = (r: ReqRow): AdminRequirement => ({
  id: r.id, code: r.code, stage: r.stage, status: r.verification_status, version: r.version,
  title: r.title, purpose: r.purpose, whoProvides: r.who_provides, whereToObtain: r.where_to_obtain,
  recommendedTiming: r.recommended_timing, conditionNote: r.condition_note, naReason: r.na_reason,
  appliesSpouse: r.applies_spouse, appliesChild: r.applies_child, appliesParent: r.applies_parent,
  appliesLocations: r.applies_locations, minAgeYears: r.min_age_years, maxAgeYears: r.max_age_years,
  requiresNullaOstaStatus: r.requires_nulla_osta_status, isConditional: r.is_conditional,
  translationRequired: r.translation_required, apostilleRequired: r.apostille_required,
  blocksSubmission: r.blocks_submission, validityDays: r.validity_days, sourceId: r.source_id,
  sourceDocument: r.source_document, sourcePublishedAt: r.source_published_at, sortOrder: r.sort_order,
  lastVerifiedAt: iso(r.last_verified_at), lastVerifiedBy: r.last_verified_by,
  createdAt: new Date(r.created_at).toISOString(), updatedAt: new Date(r.updated_at).toISOString(),
});

/** input key → [column, SQL cast]. The single place that maps the API to the table. */
const FIELD_MAP: Record<string, [column: string, cast: string]> = {
  stage: ['stage', 'text'], title: ['title', 'jsonb'], purpose: ['purpose', 'jsonb'],
  whoProvides: ['who_provides', 'jsonb'], whereToObtain: ['where_to_obtain', 'jsonb'],
  recommendedTiming: ['recommended_timing', 'jsonb'], conditionNote: ['condition_note', 'jsonb'],
  naReason: ['na_reason', 'jsonb'], appliesSpouse: ['applies_spouse', 'boolean'],
  appliesChild: ['applies_child', 'boolean'], appliesParent: ['applies_parent', 'boolean'],
  appliesLocations: ['applies_locations', 'text[]'], minAgeYears: ['min_age_years', 'smallint'],
  maxAgeYears: ['max_age_years', 'smallint'], requiresNullaOstaStatus: ['requires_nulla_osta_status', 'text[]'],
  isConditional: ['is_conditional', 'boolean'], translationRequired: ['translation_required', 'boolean'],
  apostilleRequired: ['apostille_required', 'boolean'], blocksSubmission: ['blocks_submission', 'boolean'],
  validityDays: ['validity_days', 'integer'], sourceId: ['source_id', 'uuid'],
  sourceDocument: ['source_document', 'text'], sourcePublishedAt: ['source_published_at', 'date'],
  sortOrder: ['sort_order', 'integer'],
};

/** `col = value::type` for each present key; the column names come from FIELD_MAP, never from input. */
function setClauses(fields: Record<string, unknown>): SQL[] {
  const out: SQL[] = [];
  for (const [key, value] of Object.entries(fields)) {
    const m = FIELD_MAP[key];
    if (!m || value === undefined) continue;
    const [col, cast] = m;
    const bound = cast === 'jsonb' ? (value === null ? null : JSON.stringify(value)) : value;
    out.push(sql`${sql.raw(col)} = ${bound}::${sql.raw(cast)}`);
  }
  return out;
}

async function assertSourceExists(tx: Db, sourceId: string | null | undefined): Promise<void> {
  if (!sourceId) return;
  const r = await tx.execute(sql`SELECT 1 FROM sources WHERE id = ${sourceId}::uuid`);
  if (r.rows.length === 0) throw AppError.validation({ sourceId: ['No such source.'] });
}

// ---------------------------------------------------------------------------
// requirements: read
// ---------------------------------------------------------------------------

export async function getRequirement(db: Db, id: string): Promise<AdminRequirement> {
  const r = await db.execute<ReqRow>(sql`SELECT ${REQ_COLUMNS} FROM requirements r WHERE r.id = ${id}::uuid`);
  const row = r.rows[0];
  if (!row) throw AppError.notFound('Requirement not found.');
  return toRequirement(row);
}

type Cursor3 = [number, number, string];
function decodeCatalogueCursor(raw: string): Cursor3 {
  try {
    const v: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (Array.isArray(v) && v.length === 3 && Number.isInteger(v[0]) && Number.isInteger(v[1]) &&
        typeof v[2] === 'string' && UUID_RE.test(v[2])) return [v[0] as number, v[1] as number, v[2]];
  } catch { /* fall through */ }
  throw AppError.validation({ cursor: ['Invalid cursor.'] });
}

export async function listRequirements(db: Db, q: RequirementListQuery): Promise<Page<AdminRequirementSummary>> {
  const where: SQL[] = [];
  if (q.status) where.push(sql`r.verification_status = ${q.status}`);
  if (q.stage) where.push(sql`r.stage = ${q.stage}`);
  if (q.cursor) {
    const [so, sort, id] = decodeCatalogueCursor(q.cursor);
    where.push(sql`(r.stage_order, r.sort_order, r.id) > (${so}::smallint, ${sort}::int, ${id}::uuid)`);
  }
  const r = await db.execute<{
    id: string; code: string; stage: string; stage_order: number; sort_order: number;
    verification_status: RequirementStatus; version: number; title: string; source_id: string | null;
    last_verified_at: string | null; open_flag: boolean;
  }>(sql`
    SELECT r.id, r.code, r.stage, r.stage_order, r.sort_order, r.verification_status, r.version,
           coalesce(r.title->>'en', r.code) AS title, r.source_id, r.last_verified_at,
           EXISTS (SELECT 1 FROM source_flags f WHERE f.source_id = r.source_id AND f.status = 'open') AS open_flag
      FROM requirements r
     ${where.length ? sql`WHERE ${sql.join(where, sql` AND `)}` : sql``}
     ORDER BY r.stage_order, r.sort_order, r.id
     LIMIT ${q.limit + 1}
  `);
  const page = r.rows.slice(0, q.limit);
  const last = page[page.length - 1];
  return {
    items: page.map((x) => ({
      id: x.id, code: x.code, stage: x.stage, status: x.verification_status, version: x.version,
      title: x.title, sourceId: x.source_id, lastVerifiedAt: iso(x.last_verified_at), openFlag: x.open_flag,
    })),
    nextCursor:
      r.rows.length > q.limit && last
        ? Buffer.from(JSON.stringify([last.stage_order, last.sort_order, last.id])).toString('base64url')
        : null,
  };
}

export async function listRequirementVersions(db: Db, id: string): Promise<RequirementVersionEntry[]> {
  await getRequirement(db, id); // 404 if absent
  const r = await db.execute<{
    version: number; effective_date: string; published_at: string; published_by: string;
    change_summary: Record<string, string> | null;
  }>(sql`
    SELECT version, to_char(effective_date, 'YYYY-MM-DD') AS effective_date, published_at, published_by, change_summary
      FROM requirement_versions WHERE requirement_id = ${id}::uuid ORDER BY version DESC
  `);
  return r.rows.map((v) => ({
    version: v.version, effectiveDate: v.effective_date, publishedAt: new Date(v.published_at).toISOString(),
    publishedBy: v.published_by, changeSummary: v.change_summary,
  }));
}

// ---------------------------------------------------------------------------
// requirements: write
// ---------------------------------------------------------------------------

export async function createRequirement(
  db: Db, actor: AdminContext, input: CreateRequirementInput, requestId: string,
): Promise<AdminRequirement> {
  const { code, ...fields } = input;
  const id = await db.transaction(async (tx) => {
    const dup = await tx.execute(sql`SELECT 1 FROM requirements WHERE code = ${code}`);
    if (dup.rows.length > 0) throw AppError.conflict('A requirement with that code already exists.');
    await assertSourceExists(tx, fields.sourceId);

    const names: SQL[] = [];
    const values: SQL[] = [];
    for (const [key, value] of Object.entries(fields)) {
      const m = FIELD_MAP[key];
      if (!m || value === undefined) continue;
      names.push(sql.raw(m[0]));
      values.push(sql`${m[1] === 'jsonb' ? (value === null ? null : JSON.stringify(value)) : value}::${sql.raw(m[1])}`);
    }
    const ins = await tx.execute<{ id: string }>(sql`
      INSERT INTO requirements (code, ${sql.join(names, sql`, `)})
      VALUES (${code}, ${sql.join(values, sql`, `)})
      RETURNING id
    `);
    const newId = ins.rows[0]!.id;
    await audit(tx, {
      actorType: 'admin', actorId: actor.id, action: 'requirement.create', targetType: 'requirement',
      targetId: newId, metadata: { code, stage: fields.stage }, requestId,
    });
    return newId;
  });
  return getRequirement(db, id);
}

export async function patchRequirement(
  db: Db, actor: AdminContext, id: string, input: PatchRequirementInput, requestId: string,
): Promise<AdminRequirement> {
  const { reverify, changeSummary, ...fields } = input;
  const touched = Object.keys(fields).filter((k) => fields[k as keyof typeof fields] !== undefined);

  await db.transaction(async (tx) => {
    const cur = await tx.execute<{
      verification_status: RequirementStatus; version: number; source_id: string | null; code: string;
    }>(sql`SELECT verification_status, version, source_id, code FROM requirements WHERE id = ${id}::uuid FOR UPDATE`);
    const row = cur.rows[0];
    if (!row) throw AppError.notFound('Requirement not found.');
    if (row.verification_status === 'archived') throw AppError.conflict('Archived requirements cannot be edited.');
    await assertSourceExists(tx, fields.sourceId);

    const published = row.verification_status === 'published';
    if (published) {
      if (!reverify) {
        throw AppError.conflict(
          'This requirement is published. Edit it with reverify: true (and a changeSummary) so its verification record is updated.',
        );
      }
      if (touched.length > 0 && !changeSummary) {
        throw AppError.validation({ changeSummary: ['Describe what changed — users are shown this.'] });
      }
      if (fields.sourceId === null) {
        throw AppError.validation({ sourceId: ['A published requirement must keep its source.'] });
      }
    } else if (reverify) {
      throw AppError.conflict('Only a published requirement can be re-verified.');
    }

    const sets = setClauses(fields);
    // Editing a verified (not yet published) requirement invalidates its verification.
    if (row.verification_status === 'verified' && touched.length > 0) {
      sets.push(sql`verification_status = 'created'`, sql`last_verified_at = NULL`, sql`last_verified_by = NULL`);
    }
    if (published) {
      sets.push(sql`last_verified_at = now()`, sql`last_verified_by = ${actor.id}::uuid`);
    }
    if (sets.length === 0) return;

    const upd = await tx.execute<{ version: number }>(sql`
      UPDATE requirements SET ${sql.join(sets, sql`, `)} WHERE id = ${id}::uuid RETURNING version
    `);
    const newVersion = upd.rows[0]!.version;

    let fanOut = 0;
    if (published) {
      if (newVersion > row.version) await snapshotVersion(tx, id, actor.id, changeSummary ?? null);
      fanOut = await reconcileRequirement(tx, id);
    }
    await audit(tx, {
      actorType: 'admin', actorId: actor.id,
      action: published ? 'requirement.update_published' : 'requirement.update',
      targetType: 'requirement', targetId: id,
      metadata: { code: row.code, fields: touched.sort(), fromVersion: row.version, toVersion: newVersion, rowsReconciled: fanOut },
      requestId,
    });
  });
  return getRequirement(db, id);
}

async function snapshotVersion(tx: Db, id: string, adminId: string, changeSummary: Record<string, string> | null) {
  await tx.execute(sql`
    INSERT INTO requirement_versions (requirement_id, version, snapshot, change_summary, published_by)
    SELECT r.id, r.version, to_jsonb(r) - 'created_at' - 'updated_at' - 'stage_order',
           ${changeSummary ? JSON.stringify(changeSummary) : null}::jsonb, ${adminId}::uuid
      FROM requirements r WHERE r.id = ${id}::uuid
    ON CONFLICT (requirement_id, version) DO NOTHING
  `);
}

/** The workflow: Created → Verified → Published (→ Verified again) · any → Archived · Published ↺ re-verify. */
export async function applyRequirementAction(
  db: Db, actor: AdminContext, id: string, input: RequirementActionInput, requestId: string,
): Promise<AdminRequirement> {
  await db.transaction(async (tx) => {
    const cur = await tx.execute<{
      verification_status: RequirementStatus; source_id: string | null; code: string; version: number;
    }>(sql`SELECT verification_status, source_id, code, version FROM requirements WHERE id = ${id}::uuid FOR UPDATE`);
    const row = cur.rows[0];
    if (!row) throw AppError.notFound('Requirement not found.');
    const from = row.verification_status;
    const bad = (msg: string) => AppError.conflict(`${msg} (currently ${from}).`);
    let to: RequirementStatus = from;
    let fanOut = 0;

    switch (input.action) {
      case 'verify':
        if (from !== 'created') throw bad('Only a newly created requirement can be verified');
        if (!row.source_id) throw AppError.validation({ sourceId: ['Link an authoritative source before verifying.'] });
        await tx.execute(sql`
          UPDATE requirements SET verification_status = 'verified', last_verified_at = now(),
                 last_verified_by = ${actor.id}::uuid WHERE id = ${id}::uuid`);
        to = 'verified';
        break;
      case 'publish':
        if (from !== 'verified') throw bad('Only a verified requirement can be published');
        await tx.execute(sql`UPDATE requirements SET verification_status = 'published' WHERE id = ${id}::uuid`);
        await snapshotVersion(tx, id, actor.id, input.changeSummary ?? null);
        fanOut = await reconcileRequirement(tx, id);
        to = 'published';
        break;
      case 'unpublish':
        if (from !== 'published') throw bad('Only a published requirement can be unpublished');
        await tx.execute(sql`UPDATE requirements SET verification_status = 'verified' WHERE id = ${id}::uuid`);
        to = 'verified';
        break;
      case 'archive':
        if (from === 'archived') throw bad('Already archived');
        await tx.execute(sql`UPDATE requirements SET verification_status = 'archived' WHERE id = ${id}::uuid`);
        to = 'archived';
        break;
      case 'reverify':
        if (from !== 'published') throw bad('Only a published requirement can be re-verified');
        await tx.execute(sql`
          UPDATE requirements SET last_verified_at = now(), last_verified_by = ${actor.id}::uuid
           WHERE id = ${id}::uuid`);
        break;
    }
    await audit(tx, {
      actorType: 'admin', actorId: actor.id, action: `requirement.${input.action}`, targetType: 'requirement',
      targetId: id, metadata: { code: row.code, from, to, version: row.version, rowsReconciled: fanOut }, requestId,
    });
  });
  return getRequirement(db, id);
}

// ---------------------------------------------------------------------------
// sources
// ---------------------------------------------------------------------------

type SourceRow = {
  id: string; url: string; name: Record<string, string>; authority: AdminSource['authority'];
  is_active: boolean; last_checked_at: string | null; last_changed_at: string | null;
  last_error: string | null; consecutive_failures: number; open_flag: boolean;
  created_at: string; created_at_raw: string;
};

const toSource = (s: SourceRow): AdminSource => ({
  id: s.id, url: s.url, name: s.name, authority: s.authority, isActive: s.is_active,
  lastCheckedAt: iso(s.last_checked_at), lastChangedAt: iso(s.last_changed_at), lastError: s.last_error,
  consecutiveFailures: s.consecutive_failures, openFlag: s.open_flag,
  createdAt: new Date(s.created_at).toISOString(),
});

const SOURCE_SELECT = sql`
  SELECT s.id, s.url, s.name, s.authority, s.is_active, s.last_checked_at, s.last_changed_at, s.last_error,
         s.consecutive_failures, s.created_at, s.created_at::text AS created_at_raw,
         EXISTS (SELECT 1 FROM source_flags f WHERE f.source_id = s.id AND f.status = 'open') AS open_flag
    FROM sources s
`;

export async function listSources(db: Db, cursor: string | undefined, limit: number): Promise<Page<AdminSource>> {
  const after = cursor ? decodeTsCursor(cursor) : null;
  const r = await db.execute<SourceRow>(sql`
    ${SOURCE_SELECT}
    ${after ? sql`WHERE (s.created_at, s.id) > (${after[0]}::timestamptz, ${after[1]}::uuid)` : sql``}
    ORDER BY s.created_at, s.id LIMIT ${limit + 1}
  `);
  const page = r.rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page.map(toSource),
    nextCursor: r.rows.length > limit && last ? encodeTsCursor(last.created_at_raw, last.id) : null,
  };
}

async function getSource(db: Db, id: string): Promise<AdminSource> {
  const r = await db.execute<SourceRow>(sql`${SOURCE_SELECT} WHERE s.id = ${id}::uuid`);
  const row = r.rows[0];
  if (!row) throw AppError.notFound('Source not found.');
  return toSource(row);
}

export async function createSource(
  db: Db, actor: AdminContext, input: CreateSourceInput, requestId: string,
): Promise<AdminSource> {
  const id = await db.transaction(async (tx) => {
    const dup = await tx.execute(sql`SELECT 1 FROM sources WHERE url = ${input.url}`);
    if (dup.rows.length > 0) throw AppError.conflict('That source URL is already tracked.');
    const ins = await tx.execute<{ id: string }>(sql`
      INSERT INTO sources (url, name, authority)
      VALUES (${input.url}, ${JSON.stringify(input.name)}::jsonb, ${input.authority}) RETURNING id
    `);
    const newId = ins.rows[0]!.id;
    await audit(tx, {
      actorType: 'admin', actorId: actor.id, action: 'source.create', targetType: 'source', targetId: newId,
      metadata: { authority: input.authority }, requestId,
    });
    return newId;
  });
  return getSource(db, id);
}

export async function patchSource(
  db: Db, actor: AdminContext, id: string, input: PatchSourceInput, requestId: string,
): Promise<AdminSource> {
  await db.transaction(async (tx) => {
    const exists = await tx.execute(sql`SELECT 1 FROM sources WHERE id = ${id}::uuid FOR UPDATE`);
    if (exists.rows.length === 0) throw AppError.notFound('Source not found.');
    const sets: SQL[] = [];
    if (input.name !== undefined) sets.push(sql`name = ${JSON.stringify(input.name)}::jsonb`);
    if (input.authority !== undefined) sets.push(sql`authority = ${input.authority}`);
    if (input.isActive !== undefined) sets.push(sql`is_active = ${input.isActive}`);
    await tx.execute(sql`UPDATE sources SET ${sql.join(sets, sql`, `)} WHERE id = ${id}::uuid`);
    await audit(tx, {
      actorType: 'admin', actorId: actor.id, action: 'source.update', targetType: 'source', targetId: id,
      metadata: { fields: Object.keys(input).sort() }, requestId,
    });
  });
  return getSource(db, id);
}

// ---------------------------------------------------------------------------
// hash-change flags (Screen 40)
// ---------------------------------------------------------------------------

export async function listFlags(db: Db, q: CmsListQuery): Promise<Page<SourceFlag>> {
  const after = q.cursor ? decodeTsCursor(q.cursor) : null;
  const r = await db.execute<{
    id: string; source_id: string; url: string; status: SourceFlag['status']; detected_at: string;
    detected_at_raw: string; resolved_at: string | null; resolution_note: string | null; affected: number;
  }>(sql`
    SELECT f.id, f.source_id, s.url, f.status, f.detected_at, f.detected_at::text AS detected_at_raw,
           f.resolved_at, f.resolution_note,
           (SELECT count(*)::int FROM requirements r
             WHERE r.source_id = f.source_id AND r.verification_status = 'published') AS affected
      FROM source_flags f JOIN sources s ON s.id = f.source_id
     WHERE true
       ${q.status ? sql`AND f.status = ${q.status}` : sql``}
       ${after ? sql`AND (f.detected_at, f.id) < (${after[0]}::timestamptz, ${after[1]}::uuid)` : sql``}
     ORDER BY f.detected_at DESC, f.id DESC LIMIT ${q.limit + 1}
  `);
  const page = r.rows.slice(0, q.limit);
  const last = page[page.length - 1];
  return {
    items: page.map((f) => ({
      id: f.id, sourceId: f.source_id, sourceUrl: f.url, status: f.status,
      detectedAt: new Date(f.detected_at).toISOString(), resolvedAt: iso(f.resolved_at),
      resolutionNote: f.resolution_note, affectedRequirements: f.affected,
    })),
    nextCursor: r.rows.length > q.limit && last ? encodeTsCursor(last.detected_at_raw, last.id) : null,
  };
}

/**
 * Re-verify action (Screen 40): `reverified` re-stamps every published requirement citing the source
 * (the admin checked the page) and closes the flag; `dismissed` closes it with no content change.
 * "Open the requirement for edit" is simply PATCH /requirements/:id.
 */
export async function resolveFlag(
  db: Db, actor: AdminContext, id: string, input: ResolveFlagInput, requestId: string,
): Promise<{ id: string; status: 'resolved' | 'dismissed'; requirementsRestamped: number }> {
  return db.transaction(async (tx) => {
    const f = await tx.execute<{ source_id: string; status: string }>(sql`
      SELECT source_id, status FROM source_flags WHERE id = ${id}::uuid FOR UPDATE
    `);
    const flag = f.rows[0];
    if (!flag) throw AppError.notFound('Flag not found.');
    if (flag.status !== 'open') throw AppError.conflict('This flag is already closed.');

    const status = input.action === 'reverified' ? 'resolved' : 'dismissed';
    await tx.execute(sql`
      UPDATE source_flags SET status = ${status}, resolved_by = ${actor.id}::uuid, resolved_at = now(),
             resolution_note = ${input.note ?? null} WHERE id = ${id}::uuid
    `);
    let restamped = 0;
    if (input.action === 'reverified') {
      const u = await tx.execute(sql`
        UPDATE requirements SET last_verified_at = now(), last_verified_by = ${actor.id}::uuid
         WHERE source_id = ${flag.source_id}::uuid AND verification_status = 'published'
      `);
      restamped = u.rowCount ?? 0;
    }
    await audit(tx, {
      actorType: 'admin', actorId: actor.id, action: `source_flag.${input.action}`, targetType: 'source_flag',
      targetId: id, metadata: { sourceId: flag.source_id, requirementsRestamped: restamped }, requestId,
    });
    return { id, status, requirementsRestamped: restamped };
  });
}

// ---------------------------------------------------------------------------
// the daily hash sweep (Cron) — PRD §13: we copy nothing, we only detect change
// ---------------------------------------------------------------------------

export type SourceFetcher = (
  url: string, opts: { timeoutMs: number; maxBytes: number },
) => Promise<{ bytes: Uint8Array; contentType: string }>;

export const defaultFetcher: SourceFetcher = async (url, { timeoutMs, maxBytes }) => {
  const res = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'User-Agent': 'VisaItalyPK-SourceCheck/1.0 (change detection only)', Accept: 'text/html,application/pdf,*/*;q=0.5' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > maxBytes) throw new Error('body too large');
  const reader = res.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error('body too large');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { bytes.set(c, off); off += c.length; }
  return { bytes, contentType: res.headers.get('content-type') ?? '' };
};

/**
 * Hash input. HTML is reduced to its visible text (scripts, styles, comments and whitespace
 * removed) so cookie banners and asset fingerprints do not raise flags; anything else (PDF) is
 * hashed byte-for-byte. Dynamic content can still cause a false flag — an admin dismisses it.
 */
export function normalizeForHash(bytes: Uint8Array, contentType: string): string {
  if (!/html|xml|text/i.test(contentType)) return createHash('sha256').update(bytes).digest('hex');
  const text = new TextDecoder('utf-8')
    .decode(bytes)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return createHash('sha256').update(text).digest('hex');
}

export async function sweepSources(
  db: Db, fetcher: SourceFetcher = defaultFetcher,
): Promise<{ checked: number; changed: number; failed: number }> {
  const cfg = await readConfig(db, 'verification', VERIFICATION_CONFIG_FALLBACK);
  const due = await db.execute<{ id: string; url: string; last_hash: string | null }>(sql`
    SELECT id, url, last_hash FROM sources
     WHERE is_active ORDER BY last_checked_at NULLS FIRST, id LIMIT ${cfg.hash_sweep_batch}
  `);
  let changed = 0;
  let failed = 0;
  for (const s of due.rows) {
    try {
      const { bytes, contentType } = await fetcher(s.url, { timeoutMs: cfg.fetch_timeout_ms, maxBytes: cfg.max_body_bytes });
      const hash = normalizeForHash(bytes, contentType);
      await db.transaction(async (tx) => {
        if (s.last_hash === null) {
          // First sight: record the baseline. A baseline is not a change.
          await tx.execute(sql`
            UPDATE sources SET last_hash = ${hash}, last_checked_at = now(), last_error = NULL,
                   consecutive_failures = 0 WHERE id = ${s.id}::uuid`);
        } else if (s.last_hash !== hash) {
          await tx.execute(sql`
            UPDATE sources SET last_hash = ${hash}, last_checked_at = now(), last_changed_at = now(),
                   last_error = NULL, consecutive_failures = 0 WHERE id = ${s.id}::uuid`);
          // One open flag per source: a second change while open just moves the new_hash forward.
          await tx.execute(sql`
            INSERT INTO source_flags (source_id, old_hash, new_hash) VALUES (${s.id}::uuid, ${s.last_hash}, ${hash})
            ON CONFLICT (source_id) WHERE status = 'open' DO UPDATE SET new_hash = EXCLUDED.new_hash
          `);
          await audit(tx, {
            actorType: 'system', actorId: null, action: 'source.changed', targetType: 'source', targetId: s.id,
            metadata: {},
          });
          changed++;
        } else {
          await tx.execute(sql`
            UPDATE sources SET last_checked_at = now(), last_error = NULL, consecutive_failures = 0
             WHERE id = ${s.id}::uuid`);
        }
      });
    } catch (err) {
      failed++;
      // The hash is left untouched: a failed fetch must never look like "no change" or "changed".
      await db.execute(sql`
        UPDATE sources SET last_checked_at = now(), last_error = ${(err instanceof Error ? err.message : String(err)).slice(0, 200)},
               consecutive_failures = consecutive_failures + 1 WHERE id = ${s.id}::uuid`);
    }
  }
  return { checked: due.rows.length, changed, failed };
}

// ---------------------------------------------------------------------------
// How We Verify (Screen 15) — public
// ---------------------------------------------------------------------------

export async function verificationSummary(db: Db, locale: string): Promise<VerificationSummary> {
  const [agg, recent] = await Promise.all([
    db.execute<{ tracked: number; linked: number; last_sweep: string | null; open_flags: number }>(sql`
      SELECT (SELECT count(*)::int FROM requirements WHERE verification_status = 'published') AS tracked,
             (SELECT count(*)::int FROM requirements WHERE verification_status = 'published'
                AND source_id IS NOT NULL) AS linked,
             (SELECT max(last_checked_at) FROM sources WHERE is_active) AS last_sweep,
             (SELECT count(*)::int FROM source_flags WHERE status = 'open') AS open_flags
    `),
    db.execute<{ title: string | null; summary: string | null; effective_date: string }>(sql`
      SELECT coalesce(v.snapshot->'title'->>${locale}, v.snapshot->'title'->>'en') AS title,
             coalesce(v.change_summary->>${locale}, v.change_summary->>'en') AS summary,
             to_char(v.effective_date, 'YYYY-MM-DD') AS effective_date
        FROM requirement_versions v
       ORDER BY v.published_at DESC, v.id DESC LIMIT 5
    `),
  ]);
  const a = agg.rows[0]!;
  return {
    requirementsTracked: a.tracked,
    sourceLinkedPercent: a.tracked === 0 ? 0 : Math.round((100 * a.linked) / a.tracked),
    lastSweepAt: iso(a.last_sweep),
    openFlags: a.open_flags,
    recentUpdates: recent.rows.map((r) => ({
      requirementTitle: r.title ?? '', changeSummary: r.summary, effectiveDate: r.effective_date,
    })),
  };
}
