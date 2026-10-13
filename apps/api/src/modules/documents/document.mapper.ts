import { sql, type SQL } from 'drizzle-orm';
import type { Document, DocumentMime } from '@visaitaly/shared';

/** Dates cast to text in SQL (invariant 9); size cast to int (capped at 1 GiB by the input schema). */
export type DocumentRow = {
  id: string;
  applicant_id: string;
  applicant_requirement_id: string | null;
  mime: DocumentMime;
  size_bytes: number;
  expiry_date: string | null;
  created_at: string;
  /** Exact (microsecond) text form, used only to build keyset cursors. */
  created_at_raw: string;
};

export const DOC_COLUMNS = (alias = 'd'): SQL => {
  const a = sql.raw(alias);
  return sql`${a}.id, ${a}.applicant_id, ${a}.applicant_requirement_id, ${a}.mime,
    ${a}.size_bytes::int AS size_bytes, to_char(${a}.expiry_date, 'YYYY-MM-DD') AS expiry_date,
    ${a}.created_at, ${a}.created_at::text AS created_at_raw`;
};

export function toDocument(r: DocumentRow, viewUrl: string | null = null): Document {
  return {
    id: r.id,
    applicantId: r.applicant_id,
    checklistItemId: r.applicant_requirement_id,
    mime: r.mime,
    sizeBytes: r.size_bytes,
    expiryDate: r.expiry_date,
    createdAt: new Date(r.created_at).toISOString(),
    viewUrl,
  };
}
