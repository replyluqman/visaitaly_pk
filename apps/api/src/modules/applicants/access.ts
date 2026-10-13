import {
  AccessLevel,
  PremiumStatus,
  type Applicant,
} from '@visaitaly/shared';
import { sql } from 'drizzle-orm';
import type { JourneyStage } from '@visaitaly/shared';
import type { Db } from '../../db/client.js';
import { AppError } from '../../lib/errors.js';

/** The columns access resolution reads. Shared by applicants and checklist. */
export type AccessInputs = {
  premium_status: (typeof PremiumStatus)[keyof typeof PremiumStatus];
  access_until: string | null;
  grace_until: string | null;
};

const iso = (v: string | null) => (v ? new Date(v).toISOString() : null);

/**
 * PRD §7 access resolution. Computed against now() rather than trusting
 * premium_status alone, because the daily Cron expiry sweep may not have run
 * since the window closed.
 *
 * 'none' (never purchased) is writable — a free user is still building their
 * case. Grace and expired are not: grace is explicitly read-only, and after
 * expiry the path forward is a renewal request, not an edit.
 */
export function resolveAccess(row: AccessInputs): Applicant['access'] {
  const now = Date.now();
  const live = (ts: string | null) => ts === null || new Date(ts).getTime() > now;

  let level: (typeof AccessLevel)[keyof typeof AccessLevel];
  if (row.premium_status === PremiumStatus.NONE) {
    level = AccessLevel.FREE;
  } else if (row.premium_status === PremiumStatus.ACTIVE && live(row.access_until)) {
    level = AccessLevel.PREMIUM;
  } else if (
    row.premium_status === PremiumStatus.EXPIRED_PENDING_CONFIRMATION &&
    live(row.grace_until)
  ) {
    level = AccessLevel.GRACE_READ_ONLY;
  } else {
    level = AccessLevel.EXPIRED;
  }

  return {
    level,
    canWrite: level === AccessLevel.FREE || level === AccessLevel.PREMIUM,
    accessUntil: iso(row.access_until),
    graceUntil: iso(row.grace_until),
  };
}

/** PRD §7 write gate. Enforced in the service, never only in the client. */
export function assertWritable(row: AccessInputs): void {
  const access = resolveAccess(row);
  if (access.canWrite) return;
  throw AppError.applicantReadOnly(
    access.level === AccessLevel.GRACE_READ_ONLY
      ? 'This applicant is read-only during the grace period.'
      : 'Access for this applicant has ended. Request renewal to make changes.',
  );
}

export type ApplicantAccessRow = AccessInputs & { id: string; current_stage: JourneyStage | null };

/** Ownership + access inputs in one WHERE. 404 for "not yours" and "does not exist" alike. */
export async function loadApplicantAccess(
  db: Db,
  userId: string,
  applicantId: string,
): Promise<ApplicantAccessRow> {
  const r = await db.execute<ApplicantAccessRow>(sql`
    SELECT id, current_stage, premium_status, access_until, grace_until
      FROM applicants
     WHERE id = ${applicantId}::uuid AND user_id = ${userId} AND status = 'active'
  `);
  const row = r.rows[0];
  if (!row) throw AppError.notFound('Applicant not found.');
  return row;
}
