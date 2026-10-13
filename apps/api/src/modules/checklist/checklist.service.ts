import type { Db } from '../../db/client.js';

/**
 * STUB — Module 3 (checklist engine) fills this in.
 *
 * Screens §7 requires the case to exist the moment the stage is selected, so
 * the call site is wired now: it runs inside the same transaction as the stage
 * write, which means case generation either fully succeeds or the stage change
 * rolls back with it. No half-generated case, ever.
 *
 * It cannot do real work yet: generating a case requires requirement
 * definitions, which are the CMS module (PRD §13). Until then this is a no-op
 * and `applicants.case_generated_at` stays NULL — do NOT set that column from
 * Module 2, it is how we tell a generated case from a pending one.
 *
 * Contract for Module 3: idempotent per (applicantId, category, stage), must
 * stay within the 10 ms CPU ceiling or move to the Cron Worker and leave
 * case_generated_at NULL until it has run.
 */
export async function generateCase(
  _tx: Db,
  _applicantId: string,
  _opts: { relationshipCategory: string; currentStage: string; regenerate?: boolean },
): Promise<void> {
  // no-op until requirement definitions land
}
