import { sql, type SQL } from 'drizzle-orm';
import {
  AccessLevel,
  Badge,
  ItemDisplayStatus,
  ItemStatus,
  STAGE_SEQUENCE,
  type ChecklistItem,
  type Document,
  type ChecklistItemDetail,
  type ChecklistQuery,
  type ChecklistResponse,
  type JourneyResponse,
  type JourneyStage,
  type PatchChecklistItemInput,
} from '@visaitaly/shared';
import type { Db } from '../../db/client.js';
import { AppError } from '../../lib/errors.js';
import { CHECKLIST_CONFIG_FALLBACK, VERIFICATION_CONFIG_FALLBACK, readConfig } from '../../lib/app-config.js';
import { DOC_COLUMNS, toDocument, type DocumentRow } from '../documents/document.mapper.js';
import { requirementApplies } from './applicability.js';
import {
  assertWritable,
  loadApplicantAccess,
  resolveAccess,
  type AccessInputs,
  type ApplicantAccessRow,
} from '../applicants/access.js';

// ---------------------------------------------------------------------------
// case generation (called from applicants.service, inside its transaction)
// ---------------------------------------------------------------------------

/**
 * Instantiates the catalogue for one applicant (Screens §7, PRD §12).
 *
 * Runs inside the caller's transaction, so case generation lives or dies with
 * the stage write — never a half-generated case (invariant 10).
 *
 * One INSERT … SELECT: a row for EVERY published requirement, applicable or
 * not (non-applicable items are shown greyed with a reason, PRD §12).
 * Idempotent per (applicant, requirement). On conflict only `is_applicable` is
 * recomputed, so user progress survives an edit that flips an item out and back.
 *
 * Applicability (declarative, ADR 0010 #2): category flag, location, Nulla Osta
 * status, age. An unknown date of birth never excludes an item — we show rather
 * than hide something that may be required.
 */
export async function generateCase(
  tx: Db,
  applicantId: string,
  _opts: { relationshipCategory: string; currentStage: string; regenerate?: boolean },
): Promise<void> {
  await tx.execute(sql`
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
     WHERE a.id = ${applicantId}::uuid AND r.verification_status = 'published'
    ON CONFLICT (applicant_id, requirement_id) DO UPDATE
       SET is_applicable = EXCLUDED.is_applicable
     WHERE applicant_requirements.is_applicable IS DISTINCT FROM EXCLUDED.is_applicable
  `);

  // The one place this column is written: NULL = pending, set = generated (Module 2 contract).
  await tx.execute(sql`
    UPDATE applicants SET case_generated_at = now() WHERE id = ${applicantId}::uuid
  `);
}

// ---------------------------------------------------------------------------
// shared read projection
// ---------------------------------------------------------------------------

type ItemRow = {
  id: string;
  applicant_id: string;
  code: string;
  stage: JourneyStage;
  stage_order: number;
  sort_order: number;
  title: string | null;
  status: ItemStatus;
  is_applicable: boolean;
  needs_review: boolean;
  na_reason: string | null;
  translation_required: boolean;
  apostille_required: boolean;
  blocks_submission: boolean;
  last_verified_at: string | null;
  version: number;
  updated_at: string;
  source_under_review: boolean;
  document_count: number;
  rn: number;
};

type DetailRow = ItemRow & {
  purpose: string | null;
  who_provides: string | null;
  where_to_obtain: string | null;
  recommended_timing: string | null;
  condition_note: string | null;
  source_name: string | null;
  source_url: string | null;
  source_document: string | null;
  source_published_at: string | null;
};

/**
 * Every item of one applicant, ranked for the free preview.
 *
 * `rn` ranks APPLICABLE items in journey order; non-applicable items rank in
 * their own partition and are excluded from the free response entirely.
 * Bounded by the catalogue size (tens of rows), so ranking before filtering is
 * cheap and keeps the preview cap independent of any filter or cursor.
 * Ownership is in the WHERE (`ar.user_id`), never checked after the fact.
 */
const rankedItems = (userId: string, applicantId: string, locale: string): SQL => sql`
  SELECT ar.id, ar.applicant_id, r.code, r.stage, r.stage_order, r.sort_order,
         coalesce(r.title->>${locale}, r.title->>'en')            AS title,
         ar.status, ar.is_applicable, ar.needs_review,
         coalesce(r.na_reason->>${locale}, r.na_reason->>'en')    AS na_reason,
         r.translation_required, r.apostille_required, r.blocks_submission,
         r.last_verified_at, r.version, ar.updated_at, r.updated_at AS requirement_updated_at,
         coalesce(r.purpose->>${locale}, r.purpose->>'en')                       AS purpose,
         coalesce(r.who_provides->>${locale}, r.who_provides->>'en')             AS who_provides,
         coalesce(r.where_to_obtain->>${locale}, r.where_to_obtain->>'en')       AS where_to_obtain,
         coalesce(r.recommended_timing->>${locale}, r.recommended_timing->>'en') AS recommended_timing,
         coalesce(r.condition_note->>${locale}, r.condition_note->>'en')         AS condition_note,
         coalesce(s.name->>${locale}, s.name->>'en')                             AS source_name,
         s.url AS source_url, r.source_document,
         to_char(r.source_published_at, 'YYYY-MM-DD')                            AS source_published_at,
         (SELECT count(*)::int FROM documents d
           WHERE d.applicant_requirement_id = ar.id AND d.status = 'active')    AS document_count,
         EXISTS (SELECT 1 FROM source_flags f
                  WHERE f.source_id = r.source_id AND f.status = 'open')         AS source_under_review,
         row_number() OVER (PARTITION BY ar.is_applicable
                            ORDER BY r.stage_order, r.sort_order, ar.id)         AS rn
    FROM applicant_requirements ar
    JOIN requirements r ON r.id = ar.requirement_id AND r.verification_status = 'published'
    LEFT JOIN sources s ON s.id = r.source_id
   WHERE ar.applicant_id = ${applicantId}::uuid AND ar.user_id = ${userId}
`;

const iso = (v: string | null) => (v ? new Date(v).toISOString() : null);

function toItem(r: ItemRow): ChecklistItem {
  const badges: Badge[] = [];
  if (r.is_applicable && r.blocks_submission && r.status !== ItemStatus.READY) {
    badges.push(Badge.BLOCKING);
  }
  if (r.needs_review) badges.push(Badge.NEEDS_REVIEW);
  if (r.source_under_review) badges.push(Badge.SOURCE_UNDER_REVIEW);

  return {
    id: r.id,
    requirementCode: r.code,
    stage: r.stage,
    title: r.title ?? r.code,
    status: r.is_applicable ? r.status : ItemDisplayStatus.NOT_APPLICABLE,
    badges,
    notApplicableReason: r.is_applicable ? null : (r.na_reason ?? 'Not applicable to your case.'),
    translationRequired: r.translation_required,
    apostilleRequired: r.apostille_required,
    lastVerifiedAt: iso(r.last_verified_at),
    requirementVersion: r.version,
    documentCount: r.document_count,
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// applicant gate
// ---------------------------------------------------------------------------

type ApplicantGate = ApplicantAccessRow;

const loadApplicantGate = loadApplicantAccess;

/** Free tier shows only the first N applicable items (PRD §8). Everyone else sees all. */
export async function previewCap(db: Db, access: AccessInputs): Promise<number | null> {
  if (resolveAccess(access).level !== AccessLevel.FREE) return null;
  return (await readConfig(db, 'checklist', CHECKLIST_CONFIG_FALLBACK)).free_preview_items;
}

// ---------------------------------------------------------------------------
// cursor — keyset on journey order, opaque to the client
// ---------------------------------------------------------------------------

type Cursor = [stageOrder: number, sortOrder: number, id: string];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const encodeCursor = (r: ItemRow): string =>
  Buffer.from(JSON.stringify([r.stage_order, r.sort_order, r.id])).toString('base64url');

function decodeCursor(raw: string): Cursor {
  try {
    const v: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (
      Array.isArray(v) && v.length === 3 &&
      Number.isInteger(v[0]) && Number.isInteger(v[1]) &&
      typeof v[2] === 'string' && UUID_RE.test(v[2])
    ) {
      return [v[0] as number, v[1] as number, v[2]];
    }
  } catch {
    // fall through
  }
  throw AppError.validation({ cursor: ['Invalid cursor.'] });
}

// ---------------------------------------------------------------------------
// reads
// ---------------------------------------------------------------------------

/**
 * GET /v1/applicants/:id/checklist — Screen 10.
 * Two statements regardless of item count (applicant gate + items), plus one for
 * the locked count on the free tier.
 */
export async function listChecklist(
  db: Db,
  userId: string,
  applicantId: string,
  locale: string,
  q: ChecklistQuery,
): Promise<ChecklistResponse> {
  const gate = await loadApplicantGate(db, userId, applicantId);
  const cap = await previewCap(db, gate);

  const where: SQL[] = [];
  if (cap !== null) where.push(sql`(is_applicable AND rn <= ${cap})`);
  if (q.since) {
    where.push(sql`(updated_at > ${q.since}::timestamptz OR requirement_updated_at > ${q.since}::timestamptz)`);
  }
  if (q.status === ItemDisplayStatus.NOT_APPLICABLE) where.push(sql`NOT is_applicable`);
  else if (q.status) where.push(sql`(is_applicable AND status = ${q.status})`);
  if (q.blocking !== undefined) {
    where.push(sql`((is_applicable AND blocks_submission AND status <> 'ready') = ${q.blocking})`);
  }
  if (q.translation !== undefined) where.push(sql`(translation_required = ${q.translation})`);
  if (q.apostille !== undefined) where.push(sql`(apostille_required = ${q.apostille})`);
  if (q.cursor) {
    const [so, sort, id] = decodeCursor(q.cursor);
    where.push(sql`((stage_order, sort_order, id) > (${so}::smallint, ${sort}::int, ${id}::uuid))`);
  }

  const items = await db.execute<ItemRow & { synced_at: string }>(sql`
    WITH ranked AS (${rankedItems(userId, applicantId, locale)})
    SELECT *, now() AS synced_at
      FROM ranked
     ${where.length ? sql`WHERE ${sql.join(where, sql` AND `)}` : sql``}
     ORDER BY stage_order, sort_order, id
     LIMIT ${q.limit + 1}
  `);

  let lockedCount = 0;
  if (cap !== null) {
    const c = await db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n
        FROM applicant_requirements ar
        JOIN requirements r ON r.id = ar.requirement_id AND r.verification_status = 'published'
       WHERE ar.applicant_id = ${applicantId}::uuid AND ar.user_id = ${userId} AND ar.is_applicable
    `);
    lockedCount = Math.max(0, (c.rows[0]?.n ?? 0) - cap);
  }

  const page = items.rows.slice(0, q.limit);
  const last = page[page.length - 1];
  const syncedAt = items.rows[0]?.synced_at;

  return {
    applicantId,
    items: page.map(toItem),
    lockedCount,
    nextCursor: items.rows.length > q.limit && last ? encodeCursor(last) : null,
    syncedAt: new Date(syncedAt ?? Date.now()).toISOString(),
  };
}

/**
 * Loads one item the caller owns, applying the free-preview gate.
 * 404 = not yours / absent. 402 = yours but locked.
 */
async function loadItem(
  db: Db,
  userId: string,
  itemId: string,
  locale: string,
): Promise<{ row: DetailRow; gate: ApplicantGate }> {
  const own = await db.execute<{ applicant_id: string }>(sql`
    SELECT applicant_id FROM applicant_requirements
     WHERE id = ${itemId}::uuid AND user_id = ${userId}
  `);
  const applicantId = own.rows[0]?.applicant_id;
  if (!applicantId) throw AppError.notFound('Checklist item not found.');

  const gate = await loadApplicantGate(db, userId, applicantId);
  const cap = await previewCap(db, gate);

  const result = await db.execute<DetailRow>(sql`
    WITH ranked AS (${rankedItems(userId, applicantId, locale)})
    SELECT * FROM ranked WHERE id = ${itemId}::uuid
  `);
  const row = result.rows[0];
  if (!row) throw AppError.notFound('Checklist item not found.');
  if (cap !== null && !(row.is_applicable && row.rn <= cap)) throw AppError.premiumRequired();
  return { row, gate };
}

/** GET /v1/checklist/:id — Screen 11. */
export async function getChecklistItem(
  db: Db,
  userId: string,
  itemId: string,
  locale: string,
): Promise<ChecklistItemDetail> {
  const { row, gate } = await loadItem(db, userId, itemId, locale);
  const docs = await db.execute<DocumentRow>(sql`
    SELECT ${DOC_COLUMNS('d')}
      FROM documents d
     WHERE d.applicant_requirement_id = ${itemId}::uuid AND d.user_id = ${userId} AND d.status = 'active'
     ORDER BY d.created_at, d.id
  `);
  const verification = await readConfig(db, 'verification', VERIFICATION_CONFIG_FALLBACK);
  return toDetail(row, gate, docs.rows.map((d) => toDocument(d)), verification.stale_days);
}

function toDetail(r: DetailRow, gate: AccessInputs, documents: Document[], staleAfterDays: number): ChecklistItemDetail {
  return {
    ...toItem(r),
    purpose: r.purpose,
    whoProvides: r.who_provides,
    whereToObtain: r.where_to_obtain,
    recommendedTiming: r.recommended_timing,
    conditionNote: r.condition_note,
    source: r.source_url
      ? {
          name: r.source_name ?? r.source_url,
          url: r.source_url,
          document: r.source_document,
          publishedAt: r.source_published_at,
        }
      : null,
    documents,
    canWrite: r.is_applicable && resolveAccess(gate).canWrite,
    staleAfterDays,
  };
}

/** GET /v1/applicants/:id/journey — Screen 12. Counts only, so free users may see it. */
export async function getJourney(
  db: Db,
  userId: string,
  applicantId: string,
): Promise<JourneyResponse> {
  const gate = await loadApplicantGate(db, userId, applicantId);
  const result = await db.execute<{ stage: JourneyStage; item_count: number; ready_count: number }>(sql`
    SELECT r.stage,
           count(*)::int                                   AS item_count,
           count(*) FILTER (WHERE ar.status = 'ready')::int AS ready_count
      FROM applicant_requirements ar
      JOIN requirements r ON r.id = ar.requirement_id AND r.verification_status = 'published'
     WHERE ar.applicant_id = ${applicantId}::uuid AND ar.user_id = ${userId} AND ar.is_applicable
     GROUP BY r.stage
  `);
  const byStage = new Map(result.rows.map((r) => [r.stage, r]));
  const currentIdx = gate.current_stage ? STAGE_SEQUENCE.indexOf(gate.current_stage) : -1;

  return {
    currentStage: gate.current_stage,
    stages: STAGE_SEQUENCE.map((stage, i) => ({
      stage,
      state: currentIdx === -1 || i > currentIdx ? 'upcoming' : i < currentIdx ? 'done' : 'current',
      itemCount: byStage.get(stage)?.item_count ?? 0,
      readyCount: byStage.get(stage)?.ready_count ?? 0,
    })),
  };
}

// ---------------------------------------------------------------------------
// writes
// ---------------------------------------------------------------------------

type WriteGate = AccessInputs & {
  applicant_id: string;
  is_applicable: boolean;
  version: number;
  status_updated_at: string;
};

/**
 * Locks the item row and resolves everything a write needs in one statement.
 * Order of refusals: 404 (not yours) → 403 read-only → 402 locked → 409 not applicable.
 */
async function lockForWrite(
  tx: Db,
  userId: string,
  itemId: string,
): Promise<WriteGate> {
  const r = await tx.execute<WriteGate>(sql`
    SELECT ar.applicant_id, ar.is_applicable, ar.status_updated_at, rq.version,
           a.premium_status, a.access_until, a.grace_until
      FROM applicant_requirements ar
      JOIN requirements rq ON rq.id = ar.requirement_id AND rq.verification_status = 'published'
      JOIN applicants a    ON a.id = ar.applicant_id AND a.user_id = ar.user_id
     WHERE ar.id = ${itemId}::uuid AND ar.user_id = ${userId} AND a.status = 'active'
       FOR UPDATE OF ar
  `);
  const row = r.rows[0];
  if (!row) throw AppError.notFound('Checklist item not found.');
  assertWritable(row);
  return row;
}

/** Free tier: the item must be inside the preview. 402 otherwise. Ownership is checked by callers. */
export async function assertItemVisible(
  tx: Db,
  userId: string,
  itemId: string,
  gate: AccessInputs & { applicant_id: string },
): Promise<void> {
  const cap = await previewCap(tx, gate);
  if (cap === null) return;
  const r = await tx.execute<{ rn: number; is_applicable: boolean }>(sql`
    WITH ranked AS (
      SELECT ar.id, ar.is_applicable,
             row_number() OVER (PARTITION BY ar.is_applicable
                                ORDER BY r.stage_order, r.sort_order, ar.id) AS rn
        FROM applicant_requirements ar
        JOIN requirements r ON r.id = ar.requirement_id AND r.verification_status = 'published'
       WHERE ar.applicant_id = ${gate.applicant_id}::uuid AND ar.user_id = ${userId}
    )
    SELECT rn::int AS rn, is_applicable FROM ranked WHERE id = ${itemId}::uuid
  `);
  const row = r.rows[0];
  if (!row || !row.is_applicable || row.rn > cap) throw AppError.premiumRequired();
}

/**
 * PATCH /v1/checklist/:id — set status, with offline conflict detection (PRD §12).
 *
 * A mutation made offline is applied ONLY if the item is unchanged server-side
 * since the client last synced: same requirement version, and no server-side
 * status write after the mutation was made. Otherwise it is NOT applied, the item
 * is flagged `needs_review`, and CHECKLIST_CONFLICT is returned. The flag write
 * must survive the error, so the transaction commits first and the error is
 * thrown after it.
 */
export async function setChecklistStatus(
  db: Db,
  userId: string,
  itemId: string,
  input: PatchChecklistItemInput,
  locale: string,
): Promise<ChecklistItem> {
  const outcome = await db.transaction(async (tx) => {
    const gate = await lockForWrite(tx, userId, itemId);
    await assertItemVisible(tx, userId, itemId, gate);
    if (!gate.is_applicable) {
      throw AppError.conflict('This item does not apply to this applicant.');
    }

    const versionChanged = input.baseVersion !== undefined && input.baseVersion !== gate.version;
    const modifiedSince =
      input.clientMutationAt !== undefined &&
      new Date(gate.status_updated_at).getTime() > new Date(input.clientMutationAt).getTime();

    if (versionChanged || modifiedSince) {
      await tx.execute(sql`
        UPDATE applicant_requirements SET needs_review = true
         WHERE id = ${itemId}::uuid AND user_id = ${userId}
      `);
      return 'conflict' as const;
    }

    await tx.execute(sql`
      UPDATE applicant_requirements
         SET status = ${input.status}, status_updated_at = now(),
             seen_requirement_version = ${gate.version}
       WHERE id = ${itemId}::uuid AND user_id = ${userId}
    `);
    return 'applied' as const;
  });

  if (outcome === 'conflict') throw AppError.checklistConflict();
  return (await getChecklistItem(db, userId, itemId, locale)) satisfies ChecklistItem;
}

/** POST /v1/checklist/:id/acknowledge-review — clears the Needs Review badge. */
export async function acknowledgeReview(
  db: Db,
  userId: string,
  itemId: string,
  locale: string,
): Promise<ChecklistItem> {
  await db.transaction(async (tx) => {
    const gate = await lockForWrite(tx, userId, itemId);
    await assertItemVisible(tx, userId, itemId, gate);
    await tx.execute(sql`
      UPDATE applicant_requirements
         SET needs_review = false, seen_requirement_version = ${gate.version}
       WHERE id = ${itemId}::uuid AND user_id = ${userId}
    `);
  });
  return getChecklistItem(db, userId, itemId, locale);
}
