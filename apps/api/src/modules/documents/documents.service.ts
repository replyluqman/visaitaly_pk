import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type {
  Document,
  DocumentList,
  DocumentListQuery,
  UploadUrlInput,
  UploadUrlResponse,
} from '@visaitaly/shared';
import type { Db } from '../../db/client.js';
import { AppError } from '../../lib/errors.js';
import { UPLOADS_CONFIG_FALLBACK, readConfig } from '../../lib/app-config.js';
import type { ObjectStore } from '../../lib/storage.js';
import { decodeTsCursor, encodeTsCursor } from '../../lib/cursor.js';
import { signDocumentUrl } from '../../lib/signed-url.js';
import { assertWritable, loadApplicantAccess } from '../applicants/access.js';
import { assertItemVisible } from '../checklist/checklist.service.js';
import { DOC_COLUMNS, toDocument, type DocumentRow } from './document.mapper.js';

// ---------------------------------------------------------------------------
// content verification — never trust the declared type or size
// ---------------------------------------------------------------------------

const MAGIC: Record<string, number[]> = {
  'image/jpeg': [0xff, 0xd8, 0xff],
  'image/png': [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  'application/pdf': [0x25, 0x50, 0x44, 0x46, 0x2d], // %PDF-
};
const MAGIC_BYTES = 8;

export function matchesMagic(mime: string, head: Uint8Array): boolean {
  const sig = MAGIC[mime];
  return !!sig && head.length >= sig.length && sig.every((b, i) => head[i] === b);
}

export const documentKey = (userId: string, id: string) => `u/${userId}/${id}`;

type StoredDoc = {
  id: string;
  user_id: string;
  applicant_id: string;
  r2_key: string;
  mime: string;
  size_bytes: number;
  status: 'pending' | 'active' | 'deleted';
  premium_status: 'none' | 'active' | 'expired_pending_confirmation' | 'expired';
  access_until: string | null;
  grace_until: string | null;
  created_at: string;
};

/** Live storage usage: active files plus uploads whose URL could still be used. */
async function usedBytes(db: Db, userId: string, ttlSeconds: number, excludeId?: string): Promise<number> {
  const r = await db.execute<{ n: string | null }>(sql`
    SELECT coalesce(sum(size_bytes), 0)::bigint AS n
      FROM documents
     WHERE user_id = ${userId}
       AND (status = 'active'
            OR (status = 'pending' AND created_at > now() - make_interval(secs => ${ttlSeconds})))
       ${excludeId ? sql`AND id <> ${excludeId}::uuid` : sql``}
  `);
  return Number(r.rows[0]?.n ?? 0);
}

// ---------------------------------------------------------------------------
// step 1 — reserve + hand out a short-lived upload URL
// ---------------------------------------------------------------------------

export async function createUpload(
  db: Db,
  signingKey: string,
  origin: string,
  userId: string,
  input: UploadUrlInput,
): Promise<UploadUrlResponse> {
  const cfg = await readConfig(db, 'uploads', UPLOADS_CONFIG_FALLBACK);
  if (!cfg.allowed_mimes.includes(input.mime)) {
    throw AppError.validation({ mime: ['This file type is not accepted.'] });
  }
  if (input.sizeBytes > cfg.max_file_bytes) throw AppError.uploadTooLarge(cfg.max_file_bytes);

  const id = randomUUID();
  await db.transaction(async (tx) => {
    const applicant = await loadApplicantAccess(tx, userId, input.applicantId);
    assertWritable(applicant);

    if (input.checklistItemId) {
      // Ownership AND same applicant, in the WHERE.
      const item = await tx.execute<{ is_applicable: boolean }>(sql`
        SELECT is_applicable FROM applicant_requirements
         WHERE id = ${input.checklistItemId}::uuid AND user_id = ${userId}
           AND applicant_id = ${input.applicantId}::uuid
      `);
      if (!item.rows[0]) throw AppError.notFound('Checklist item not found.');
      if (!item.rows[0].is_applicable) {
        throw AppError.conflict('This item does not apply to this applicant.');
      }
      await assertItemVisible(tx, userId, input.checklistItemId, {
        ...applicant,
        applicant_id: input.applicantId,
      });
    }

    // Serialise this user's quota check so two parallel requests cannot both fit.
    await tx.execute(sql`SELECT 1 FROM users WHERE id = ${userId} FOR UPDATE`);
    const used = await usedBytes(tx, userId, cfg.upload_url_ttl_seconds);
    if (used + input.sizeBytes > cfg.max_bytes_per_user) throw AppError.uploadQuotaExceeded();

    await tx.execute(sql`
      INSERT INTO documents (id, user_id, applicant_id, applicant_requirement_id, r2_key, mime,
                             size_bytes, client_sha256, expiry_date)
      VALUES (${id}::uuid, ${userId}, ${input.applicantId}::uuid,
              ${input.checklistItemId ?? null}::uuid, ${documentKey(userId, id)}, ${input.mime},
              ${input.sizeBytes}, ${input.sha256}, ${input.expiryDate ?? null}::date)
    `);
  });

  const { exp, sig } = await signDocumentUrl(signingKey, 'PUT', id, cfg.upload_url_ttl_seconds);
  return {
    id,
    uploadUrl: `${origin}/v1/documents/${id}/content?exp=${exp}&sig=${sig}`,
    expiresAt: new Date(exp * 1000).toISOString(),
    requiredHeaders: { 'Content-Type': input.mime },
  };
}

// ---------------------------------------------------------------------------
// the bytes — capability URLs, no session (an <Image> widget cannot send headers)
// ---------------------------------------------------------------------------

/** Pending row a PUT may fill. Looked up by unguessable id; the signature is checked by the caller. */
export async function loadForUpload(
  db: Db,
  id: string,
): Promise<{ r2_key: string; mime: string; size_bytes: number } | null> {
  const r = await db.execute<{ r2_key: string; mime: string; size_bytes: number }>(sql`
    SELECT d.r2_key, d.mime, d.size_bytes::int AS size_bytes
      FROM documents d
      JOIN applicants a ON a.id = d.applicant_id AND a.user_id = d.user_id
     WHERE d.id = ${id}::uuid AND d.status = 'pending' AND a.status = 'active'
  `);
  return r.rows[0] ?? null;
}

export async function loadForView(
  db: Db,
  id: string,
): Promise<{ r2_key: string; mime: string } | null> {
  const r = await db.execute<{ r2_key: string; mime: string }>(sql`
    SELECT r2_key, mime FROM documents WHERE id = ${id}::uuid AND status = 'active'
  `);
  return r.rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// step 2 — verify what actually landed, then activate
// ---------------------------------------------------------------------------

async function discard(db: Db, store: ObjectStore, doc: Pick<StoredDoc, 'id' | 'r2_key'>) {
  await store.delete(doc.r2_key);
  await db.execute(sql`
    UPDATE documents SET status = 'deleted', deleted_at = now() WHERE id = ${doc.id}::uuid
  `);
}

export async function completeUpload(
  db: Db,
  store: ObjectStore,
  userId: string,
  id: string,
): Promise<Document> {
  const found = await db.execute<StoredDoc>(sql`
    SELECT d.id, d.user_id, d.applicant_id, d.r2_key, d.mime, d.size_bytes::int AS size_bytes, d.status,
           a.premium_status, a.access_until, a.grace_until, d.created_at
      FROM documents d
      JOIN applicants a ON a.id = d.applicant_id AND a.user_id = d.user_id
     WHERE d.id = ${id}::uuid AND d.user_id = ${userId} AND d.status IN ('pending','active')
  `);
  const doc = found.rows[0];
  if (!doc) throw AppError.notFound('Document not found.');
  if (doc.status === 'active') return getDocumentMeta(db, userId, id);
  assertWritable(doc);

  const stat = await store.head(doc.r2_key);
  if (!stat) throw AppError.uploadRejected();
  const head = stat.size === doc.size_bytes ? await store.readHead(doc.r2_key, MAGIC_BYTES) : null;
  if (!head || !matchesMagic(doc.mime, head)) {
    await discard(db, store, doc); // wrong size or wrong type: keep nothing
    throw AppError.uploadRejected();
  }

  const cfg = await readConfig(db, 'uploads', UPLOADS_CONFIG_FALLBACK);
  const quotaOk = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT 1 FROM users WHERE id = ${userId} FOR UPDATE`);
    const others = await usedBytes(tx, userId, cfg.upload_url_ttl_seconds, id);
    if (others + doc.size_bytes > cfg.max_bytes_per_user) return false;
    await tx.execute(sql`
      UPDATE documents SET status = 'active', completed_at = now()
       WHERE id = ${id}::uuid AND user_id = ${userId} AND status = 'pending'
    `);
    return true;
  });
  if (!quotaOk) {
    await discard(db, store, doc);
    throw AppError.uploadQuotaExceeded();
  }
  return getDocumentMeta(db, userId, id);
}

// ---------------------------------------------------------------------------
// reads
// ---------------------------------------------------------------------------

export async function listDocuments(
  db: Db,
  userId: string,
  q: DocumentListQuery,
): Promise<DocumentList> {
  const cfg = await readConfig(db, 'uploads', UPLOADS_CONFIG_FALLBACK);
  let cursorClause = sql``;
  if (q.cursor) {
    const [at, id] = decodeTsCursor(q.cursor);
    cursorClause = sql`AND (d.created_at, d.id) < (${at}::timestamptz, ${id}::uuid)`;
  }
  const rows = await db.execute<DocumentRow>(sql`
    SELECT ${DOC_COLUMNS('d')}
      FROM documents d
     WHERE d.user_id = ${userId} AND d.status = 'active'
       ${q.applicantId ? sql`AND d.applicant_id = ${q.applicantId}::uuid` : sql``}
       ${cursorClause}
     ORDER BY d.created_at DESC, d.id DESC
     LIMIT ${q.limit + 1}
  `);
  const page = rows.rows.slice(0, q.limit);
  const last = page[page.length - 1];
  return {
    items: page.map((r) => toDocument(r)),
    nextCursor: rows.rows.length > q.limit && last ? encodeTsCursor(last.created_at_raw, last.id) : null,
    quota: {
      usedBytes: await usedBytes(db, userId, cfg.upload_url_ttl_seconds),
      maxBytes: cfg.max_bytes_per_user,
    },
  };
}

/** Metadata only. 404 for "not yours" and "does not exist" alike. */
export async function getDocumentMeta(db: Db, userId: string, id: string): Promise<Document> {
  const r = await db.execute<DocumentRow>(sql`
    SELECT ${DOC_COLUMNS('d')} FROM documents d
     WHERE d.id = ${id}::uuid AND d.user_id = ${userId} AND d.status = 'active'
  `);
  const row = r.rows[0];
  if (!row) throw AppError.notFound('Document not found.');
  return toDocument(row);
}

/** Metadata plus a short-lived signed GET for the bytes. */
export async function getDocumentWithUrl(
  db: Db,
  signingKey: string,
  origin: string,
  userId: string,
  id: string,
): Promise<Document> {
  const doc = await getDocumentMeta(db, userId, id);
  const cfg = await readConfig(db, 'uploads', UPLOADS_CONFIG_FALLBACK);
  const { exp, sig } = await signDocumentUrl(signingKey, 'GET', id, cfg.view_url_ttl_seconds);
  return { ...doc, viewUrl: `${origin}/v1/documents/${id}/content?exp=${exp}&sig=${sig}` };
}

// ---------------------------------------------------------------------------
// delete — the R2 object first, the row second (SECURITY.md)
// ---------------------------------------------------------------------------

export async function deleteDocument(
  db: Db,
  store: ObjectStore,
  userId: string,
  id: string,
): Promise<void> {
  const found = await db.execute<StoredDoc>(sql`
    SELECT d.id, d.user_id, d.applicant_id, d.r2_key, d.mime, d.size_bytes::int AS size_bytes, d.status,
           a.premium_status, a.access_until, a.grace_until, d.created_at
      FROM documents d
      JOIN applicants a ON a.id = d.applicant_id AND a.user_id = d.user_id
     WHERE d.id = ${id}::uuid AND d.user_id = ${userId} AND d.status IN ('pending','active')
  `);
  const doc = found.rows[0];
  if (!doc) throw AppError.notFound('Document not found.');
  assertWritable(doc);
  // If the store call throws, the row is untouched and the request can be retried.
  await discard(db, store, doc);
}

// ---------------------------------------------------------------------------
// Cron — retention (docs/ERD.md §Module 3b)
// ---------------------------------------------------------------------------

/** Abandoned uploads (URL long expired) lose their object; old soft-deleted rows are purged. */
export async function purgeStaleDocuments(
  db: Db,
  store: ObjectStore,
): Promise<{ abandoned: number; purged: number }> {
  const cfg = await readConfig(db, 'uploads', UPLOADS_CONFIG_FALLBACK);
  const stale = await db.execute<{ id: string; r2_key: string }>(sql`
    SELECT id, r2_key FROM documents
     WHERE status = 'pending' AND created_at < now() - make_interval(secs => ${cfg.upload_url_ttl_seconds * 2})
     LIMIT 500
  `);
  for (const d of stale.rows) await discard(db, store, d);

  const purged = await db.execute(sql`
    DELETE FROM documents
     WHERE status = 'deleted' AND deleted_at < now() - make_interval(days => ${cfg.deleted_retention_days})
  `);
  return { abandoned: stale.rows.length, purged: purged.rowCount ?? 0 };
}
