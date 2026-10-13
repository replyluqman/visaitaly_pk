import { sql } from 'drizzle-orm';
import { OnboardingState } from '@visaitaly/shared';
import type { Db } from '../../db/client.js';
import { AppError } from '../../lib/errors.js';

/**
 * Recompute users.onboarding_state from facts, never from a client claim.
 * Called inside the transaction of every mutation that can move the needle:
 * legal acceptance, applicant create/delete, stage set.
 *
 * Rules (Screens §1 routes on the result):
 *  - any mandatory current legal doc unaccepted        -> disclaimer_pending
 *  - fewer applicants than declared (min 1)            -> applicants_pending
 *  - any applicant without a stage                     -> stage_pending
 *  - otherwise                                         -> complete
 *
 * 'complete' NEVER regresses. Otherwise adding a 5th applicant a month later
 * would drop the user back into the onboarding flow. Post-onboarding creates
 * require a stage in the same request instead (see applicants.service).
 *
 * Legal is matched on (doc_type, version), not version id, so accepting the
 * English 1.0 disclaimer also satisfies the Urdu 1.0 disclaimer.
 */
export async function recomputeOnboardingState(
  db: Db,
  userId: string,
): Promise<OnboardingState> {
  const result = await db.execute<{ onboarding_state: OnboardingState }>(sql`
    WITH counts AS (
      SELECT count(*)::int                                        AS total,
             count(*) FILTER (WHERE current_stage IS NULL)::int    AS awaiting_stage
        FROM applicants
       WHERE user_id = ${userId} AND status = 'active'
    ),
    legal AS (
      SELECT NOT EXISTS (
        SELECT 1
          FROM legal_versions v
         WHERE v.is_current AND v.is_mandatory
           AND NOT EXISTS (
             SELECT 1
               FROM legal_acceptances a
               JOIN legal_versions av ON av.id = a.legal_version_id
              WHERE a.user_id = ${userId}
                AND av.doc_type = v.doc_type
                AND av.version  = v.version
           )
      ) AS legal_ok
    )
    UPDATE users u
       SET onboarding_state = CASE
             WHEN u.onboarding_state = ${OnboardingState.COMPLETE} THEN ${OnboardingState.COMPLETE}
             WHEN NOT l.legal_ok THEN ${OnboardingState.DISCLAIMER_PENDING}
             WHEN c.total = 0
               OR c.total < COALESCE(u.declared_applicant_count, 1)
               THEN ${OnboardingState.APPLICANTS_PENDING}
             WHEN c.awaiting_stage > 0 THEN ${OnboardingState.STAGE_PENDING}
             ELSE ${OnboardingState.COMPLETE}
           END
      FROM counts c, legal l
     WHERE u.id = ${userId}
    RETURNING u.onboarding_state
  `);

  const row = result.rows[0];
  if (!row) throw new Error(`recomputeOnboardingState: user ${userId} not found`);
  return row.onboarding_state;
}

/**
 * Screens §5 — the 1 / 2 / 3 / 4+ selector. Declared intent only; it drives the
 * profile loop and the resume point, and is never treated as a count of rows.
 */
export async function setDeclaredApplicantCount(
  db: Db,
  userId: string,
  count: number,
): Promise<{ declaredApplicantCount: number; onboardingState: OnboardingState }> {
  return db.transaction(async (tx) => {
    const current = await tx.execute<{ onboarding_state: OnboardingState }>(sql`
      SELECT onboarding_state FROM users WHERE id = ${userId}
    `);
    const state = current.rows[0]?.onboarding_state;
    if (!state) throw AppError.notFound('Account not found.');
    if (state === OnboardingState.DISCLAIMER_PENDING) throw AppError.legalRequired();

    await tx.execute(sql`
      UPDATE users SET declared_applicant_count = ${count} WHERE id = ${userId}
    `);

    return {
      declaredApplicantCount: count,
      onboardingState: await recomputeOnboardingState(tx, userId),
    };
  });
}
