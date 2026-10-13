import { AppError } from './errors.js';

/**
 * Keyset cursors on (timestamp, id).
 *
 * The timestamp travels as Postgres TEXT (`created_at::text`), never as a JS Date: node-postgres
 * parses timestamptz to a millisecond-precision Date, and a cursor rebuilt from it sorts BEFORE
 * rows that share its millisecond but differ in microseconds — those rows are then silently
 * skipped or repeated across pages. Text round-trips exactly.
 */
const TS_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}(:\d{2})?$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const encodeTsCursor = (createdAtText: string, id: string): string =>
  Buffer.from(JSON.stringify([createdAtText, id])).toString('base64url');

export function decodeTsCursor(raw: string): [string, string] {
  try {
    const v: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (
      Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && typeof v[1] === 'string' &&
      TS_RE.test(v[0]) && UUID_RE.test(v[1])
    ) {
      return [v[0], v[1]];
    }
  } catch {
    // fall through
  }
  throw AppError.validation({ cursor: ['Invalid cursor.'] });
}
