import { sql, type SQL } from 'drizzle-orm';
import type {
  AdminLegalVersion,
  CaseLookup,
  CreateLegalVersionInput,
  LegalAcceptanceRecord,
  LookupQuery,
  Page,
  PatchLegalVersionInput,
} from '@visaitaly/shared';
import type { Db } from '../../db/client.js';
import type { AdminContext } from '../../env.js';
import { AppError } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { decodeTsCursor, encodeTsCursor } from '../../lib/cursor.js';

const iso = (v: string | null) => (v ? new Date(v).toISOString() : null);

// ---------------------------------------------------------------------------
// Legal / Disclaimer version manager (Screen 44, scope legal_manage)
// ---------------------------------------------------------------------------

type VersionRow = {
  id: string; doc_type: AdminLegalVersion['docType']; locale: string; version: string; title: string;
  is_mandatory: boolean; is_current: boolean; published_at: string | null; published_by: string | null;
  created_at: string; created_at_raw: string; acceptance_count: number;
};

const SELECT_VERSION = sql`
  SELECT v.id, v.doc_type, v.locale, v.version, v.title, v.is_mandatory, v.is_current, v.published_at, v.published_by,
         v.created_at, v.created_at::text AS created_at_raw,
         (SELECT count(*)::int FROM legal_acceptances a WHERE a.legal_version_id = v.id) AS acceptance_count
    FROM legal_versions v
`;

const toVersion = (r: VersionRow): AdminLegalVersion => ({
  id: r.id, docType: r.doc_type, locale: r.locale, version: r.version, title: r.title,
  isMandatory: r.is_mandatory, isCurrent: r.is_current, publishedAt: iso(r.published_at),
  publishedBy: r.published_by, acceptanceCount: r.acceptance_count, createdAt: new Date(r.created_at).toISOString(),
});

async function getVersion(db: Db, id: string): Promise<AdminLegalVersion> {
  const r = await db.execute<VersionRow>(sql`${SELECT_VERSION} WHERE v.id = ${id}::uuid`);
  const row = r.rows[0];
  if (!row) throw AppError.notFound('Legal version not found.');
  return toVersion(row);
}

export async function listLegalVersions(
  db: Db, q: { docType?: string; cursor?: string; limit: number },
): Promise<Page<AdminLegalVersion>> {
  const after = q.cursor ? decodeTsCursor(q.cursor) : null;
  const r = await db.execute<VersionRow>(sql`
    ${SELECT_VERSION}
    WHERE true ${q.docType ? sql`AND v.doc_type = ${q.docType}` : sql``}
      ${after ? sql`AND (v.created_at, v.id) < (${after[0]}::timestamptz, ${after[1]}::uuid)` : sql``}
    ORDER BY v.created_at DESC, v.id DESC LIMIT ${q.limit + 1}
  `);
  const page = r.rows.slice(0, q.limit);
  const last = page[page.length - 1];
  return {
    items: page.map(toVersion),
    nextCursor: r.rows.length > q.limit && last ? encodeTsCursor(last.created_at_raw, last.id) : null,
  };
}

export async function createLegalVersion(
  db: Db, actor: AdminContext, input: CreateLegalVersionInput, requestId: string,
): Promise<AdminLegalVersion> {
  const id = await db.transaction(async (tx) => {
    const dup = await tx.execute(sql`
      SELECT 1 FROM legal_versions WHERE doc_type = ${input.docType} AND locale = ${input.locale} AND version = ${input.version}
    `);
    if (dup.rows.length > 0) throw AppError.conflict('That version already exists for this document and locale.');
    const r = await tx.execute<{ id: string }>(sql`
      INSERT INTO legal_versions (doc_type, locale, version, title, body_md, is_mandatory)
      VALUES (${input.docType}, ${input.locale}, ${input.version}, ${input.title}, ${input.bodyMd}, ${input.isMandatory})
      RETURNING id
    `);
    const newId = r.rows[0]!.id;
    await audit(tx, {
      actorType: 'admin', actorId: actor.id, action: 'legal.create', targetType: 'legal_version', targetId: newId,
      metadata: { docType: input.docType, locale: input.locale, version: input.version }, requestId,
    });
    return newId;
  });
  return getVersion(db, id);
}

/** Drafts only. A published version is the text users accepted — it is superseded, never edited. */
export async function patchLegalVersion(
  db: Db, actor: AdminContext, id: string, input: PatchLegalVersionInput, requestId: string,
): Promise<AdminLegalVersion> {
  await db.transaction(async (tx) => {
    const cur = await tx.execute<{ published_at: string | null }>(sql`SELECT published_at FROM legal_versions WHERE id = ${id}::uuid FOR UPDATE`);
    if (!cur.rows[0]) throw AppError.notFound('Legal version not found.');
    if (cur.rows[0].published_at) throw AppError.conflict('A published version cannot be edited. Create a new version instead.');
    const sets: SQL[] = [];
    if (input.title !== undefined) sets.push(sql`title = ${input.title}`);
    if (input.bodyMd !== undefined) sets.push(sql`body_md = ${input.bodyMd}`);
    if (input.isMandatory !== undefined) sets.push(sql`is_mandatory = ${input.isMandatory}`);
    await tx.execute(sql`UPDATE legal_versions SET ${sql.join(sets, sql`, `)} WHERE id = ${id}::uuid`);
    await audit(tx, {
      actorType: 'admin', actorId: actor.id, action: 'legal.update', targetType: 'legal_version', targetId: id,
      metadata: { fields: Object.keys(input).sort() }, requestId,
    });
  });
  return getVersion(db, id);
}

/**
 * Makes a draft the current version of its (document, locale). Atomic: the previous current version is
 * demoted and the new one promoted in one transaction, so there is never zero or two. Users who accepted
 * an older version are asked again on their next launch (acceptance matches on (doc_type, version),
 * which /v1/me recomputes) — publishing 1.1 correctly forces re-acceptance.
 */
export async function publishLegalVersion(
  db: Db, actor: AdminContext, id: string, requestId: string,
): Promise<AdminLegalVersion> {
  await db.transaction(async (tx) => {
    const cur = await tx.execute<{ doc_type: string; locale: string; version: string; published_at: string | null }>(sql`
      SELECT doc_type, locale, version, published_at FROM legal_versions WHERE id = ${id}::uuid FOR UPDATE
    `);
    const v = cur.rows[0];
    if (!v) throw AppError.notFound('Legal version not found.');
    if (v.published_at) throw AppError.conflict('This version is already published.');
    await tx.execute(sql`UPDATE legal_versions SET is_current = false WHERE doc_type = ${v.doc_type} AND locale = ${v.locale} AND is_current`);
    await tx.execute(sql`
      UPDATE legal_versions SET is_current = true, published_at = now(), published_by = ${actor.id}::uuid WHERE id = ${id}::uuid
    `);
    await audit(tx, {
      actorType: 'admin', actorId: actor.id, action: 'legal.publish', targetType: 'legal_version', targetId: id,
      metadata: { docType: v.doc_type, locale: v.locale, version: v.version }, requestId,
    });
  });
  return getVersion(db, id);
}

/** Who accepted a version, when (Screen 44). User ids only — no PII; the read is itself audited. */
export async function listAcceptances(
  db: Db, actor: AdminContext, id: string, cursor: string | undefined, limit: number, requestId: string,
): Promise<Page<LegalAcceptanceRecord>> {
  await getVersion(db, id);
  const after = cursor ? decodeTsCursor(cursor) : null;
  const r = await db.execute<{ id: string; user_id: string; accepted_at: string; accepted_at_raw: string; app_version: string | null }>(sql`
    SELECT id, user_id, accepted_at, accepted_at::text AS accepted_at_raw, app_version FROM legal_acceptances
     WHERE legal_version_id = ${id}::uuid
       ${after ? sql`AND (accepted_at, id) > (${after[0]}::timestamptz, ${after[1]}::uuid)` : sql``}
     ORDER BY accepted_at, id LIMIT ${limit + 1}
  `);
  const page = r.rows.slice(0, limit);
  const last = page[page.length - 1];
  await audit(db, {
    actorType: 'admin', actorId: actor.id, action: 'legal.view_acceptances', targetType: 'legal_version', targetId: id,
    metadata: { returned: page.length }, requestId,
  });
  return {
    items: page.map((a) => ({ userId: a.user_id, acceptedAt: new Date(a.accepted_at).toISOString(), appVersion: a.app_version })),
    nextCursor: r.rows.length > limit && last ? encodeTsCursor(last.accepted_at_raw, last.id) : null,
  };
}

// ---------------------------------------------------------------------------
// User / Case Lookup (Screen 36, read_only and above) — itself a privacy surface
// ---------------------------------------------------------------------------

/**
 * Read-only view of one account. Exactly one lookup key. EVERY lookup is audited — found or not —
 * with the key TYPE and the resulting user id, never the email typed (PRD §16: lookups are logged even
 * though read-only). Documents, tokens and message bodies are never returned.
 */
export async function lookupCase(
  db: Db, actor: AdminContext, q: LookupQuery, requestId: string,
): Promise<CaseLookup> {
  const by = q.email !== undefined ? 'email' : 'userId';
  const found = await db.execute<{
    id: string; email: string | null; display_name: string | null; status: string; onboarding_state: string;
    created_at: string; last_login_at: string | null;
  }>(
    q.email !== undefined
      ? sql`SELECT id, email, display_name, status, onboarding_state, created_at, last_login_at FROM users WHERE lower(email) = ${q.email} LIMIT 1`
      : sql`SELECT id, email, display_name, status, onboarding_state, created_at, last_login_at FROM users WHERE id = ${q.userId}::uuid`,
  );
  const u = found.rows[0];
  await audit(db, {
    actorType: 'admin', actorId: actor.id, action: 'case.lookup', targetType: 'user', targetId: u?.id,
    metadata: { by, found: !!u }, requestId,
  });
  if (!u) throw AppError.notFound('No matching account.');

  const [applicants, devices, acceptances, requests] = await Promise.all([
    db.execute<{
      id: string; display_name: string; relationship_code: string; current_stage: string | null; premium_status: string;
      access_until: string | null; grace_until: string | null; applicable: number; ready: number; blocking: number;
    }>(sql`
      SELECT a.id, a.display_name, a.relationship_code, a.current_stage, a.premium_status, a.access_until, a.grace_until,
             coalesce(rd.applicable, 0) AS applicable, coalesce(rd.ready, 0) AS ready, coalesce(rd.blocking, 0) AS blocking
        FROM applicants a
        LEFT JOIN LATERAL (
          SELECT count(*) FILTER (WHERE ar.is_applicable)::int AS applicable,
                 count(*) FILTER (WHERE ar.is_applicable AND ar.status = 'ready')::int AS ready,
                 count(*) FILTER (WHERE ar.is_applicable AND rq.blocks_submission AND ar.status <> 'ready')::int AS blocking
            FROM applicant_requirements ar JOIN requirements rq ON rq.id = ar.requirement_id AND rq.verification_status = 'published'
           WHERE ar.applicant_id = a.id AND ar.user_id = a.user_id) rd ON true
       WHERE a.user_id = ${u.id} AND a.status = 'active' ORDER BY a.created_at
    `),
    db.execute<{ platform: string; model: string | null; app_version: string | null; status: string; last_seen_at: string }>(sql`
      SELECT platform, model, app_version, status, last_seen_at FROM devices WHERE user_id = ${u.id} ORDER BY last_seen_at DESC LIMIT 20
    `),
    db.execute<{ doc_type: string; version: string; accepted_at: string }>(sql`
      SELECT v.doc_type, v.version, a.accepted_at FROM legal_acceptances a JOIN legal_versions v ON v.id = a.legal_version_id
       WHERE a.user_id = ${u.id} ORDER BY a.accepted_at DESC LIMIT 20
    `),
    db.execute<{ kind: string; status: string; requested_at: string }>(sql`
      SELECT kind, status, requested_at FROM data_requests WHERE user_id = ${u.id} ORDER BY requested_at DESC LIMIT 20
    `),
  ]);
  return {
    user: {
      id: u.id, email: u.email, displayName: u.display_name, status: u.status, onboardingState: u.onboarding_state,
      createdAt: new Date(u.created_at).toISOString(), lastLoginAt: iso(u.last_login_at),
    },
    applicants: applicants.rows.map((a) => ({
      id: a.id, displayName: a.display_name, relationshipCode: a.relationship_code, currentStage: a.current_stage,
      premiumStatus: a.premium_status, accessUntil: iso(a.access_until), graceUntil: iso(a.grace_until),
      readiness: { applicable: a.applicable, ready: a.ready, blocking: a.blocking },
    })),
    devices: devices.rows.map((d) => ({ platform: d.platform, model: d.model, appVersion: d.app_version, status: d.status, lastSeenAt: new Date(d.last_seen_at).toISOString() })),
    legalAcceptances: acceptances.rows.map((a) => ({ docType: a.doc_type, version: a.version, acceptedAt: new Date(a.accepted_at).toISOString() })),
    dataRequests: requests.rows.map((r) => ({ kind: r.kind, status: r.status, requestedAt: new Date(r.requested_at).toISOString() })),
  };
}
