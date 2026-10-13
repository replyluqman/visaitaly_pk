import { sql, type SQL } from 'drizzle-orm';
import {
  AccessLevel,
  NullaOstaStatus,
  OnboardingState,
  PremiumStatus,
  type Applicant,
  type ApplicantListResponse,
  type ApplicantLocation,
  type CreateApplicantInput,
  type JourneyStage,
  type PatchApplicantInput,
  type RelationshipCategory,
} from '@visaitaly/shared';
import type { Db } from '../../db/client.js';
import { AppError } from '../../lib/errors.js';
import {
  NULLA_OSTA_CONFIG_FALLBACK,
  ONBOARDING_CONFIG_FALLBACK,
  readConfig,
  type NullaOstaConfigValue,
} from '../../lib/app-config.js';
import { recomputeOnboardingState } from '../onboarding/onboarding.service.js';
import { generateCase } from '../checklist/checklist.service.js';

// ---------------------------------------------------------------------------
// row shape + mapping
// ---------------------------------------------------------------------------

/**
 * Dates are cast to text in SQL. node-postgres parses a DATE column into a JS
 * Date at local midnight, which silently shifts the day in any non-UTC runtime.
 * Text in, text out, no timezone surface.
 */
type ApplicantRowRaw = {
  id: string;
  display_name: string;
  relationship_code: string;
  relationship_category: RelationshipCategory;
  relationship_label: string | null;
  date_of_birth: string | null;
  current_location: ApplicantLocation;
  current_stage: JourneyStage | null;
  stage_updated_at: string | null;
  case_generated_at: string | null;
  nulla_osta_status: (typeof NullaOstaStatus)[keyof typeof NullaOstaStatus];
  nulla_osta_issue_date: string | null;
  nulla_osta_expiry_date: string | null;
  nulla_osta_days_remaining: number | null;
  premium_status: (typeof PremiumStatus)[keyof typeof PremiumStatus];
  access_until: string | null;
  grace_until: string | null;
  created_at: string;
}

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
function resolveAccess(row: ApplicantRowRaw): Applicant['access'] {
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

function mapApplicant(row: ApplicantRowRaw, labelOverride?: string): Applicant {
  return {
    id: row.id,
    displayName: row.display_name,
    relationshipCode: row.relationship_code,
    relationshipLabel: labelOverride ?? row.relationship_label ?? row.relationship_code,
    relationshipCategory: row.relationship_category,
    dateOfBirth: row.date_of_birth,
    currentLocation: row.current_location,
    currentStage: row.current_stage,
    stageUpdatedAt: iso(row.stage_updated_at),
    caseGeneratedAt: iso(row.case_generated_at),
    nullaOsta: {
      status: row.nulla_osta_status,
      issueDate: row.nulla_osta_issue_date,
      expiryDate: row.nulla_osta_expiry_date,
      daysRemaining: row.nulla_osta_days_remaining,
    },
    access: resolveAccess(row),
    createdAt: new Date(row.created_at).toISOString(),
  };
}

/** Shared projection. daysRemaining is computed in SQL — zero JS date maths. */
const columns = (locale: string): SQL => sql`
  a.id, a.display_name, a.relationship_code, a.relationship_category,
  coalesce(r.labels->>${locale}, r.labels->>'en')          AS relationship_label,
  to_char(a.date_of_birth, 'YYYY-MM-DD')                   AS date_of_birth,
  a.current_location, a.current_stage, a.stage_updated_at, a.case_generated_at,
  a.nulla_osta_status,
  to_char(a.nulla_osta_issue_date,  'YYYY-MM-DD')          AS nulla_osta_issue_date,
  to_char(a.nulla_osta_expiry_date, 'YYYY-MM-DD')          AS nulla_osta_expiry_date,
  (a.nulla_osta_expiry_date - CURRENT_DATE)                AS nulla_osta_days_remaining,
  a.premium_status, a.access_until, a.grace_until, a.created_at
`;

const RETURNING_COLUMNS: SQL = sql`
  id, display_name, relationship_code, relationship_category,
  NULL::text                                        AS relationship_label,
  to_char(date_of_birth, 'YYYY-MM-DD')              AS date_of_birth,
  current_location, current_stage, stage_updated_at, case_generated_at,
  nulla_osta_status,
  to_char(nulla_osta_issue_date,  'YYYY-MM-DD')     AS nulla_osta_issue_date,
  to_char(nulla_osta_expiry_date, 'YYYY-MM-DD')     AS nulla_osta_expiry_date,
  (nulla_osta_expiry_date - CURRENT_DATE)           AS nulla_osta_days_remaining,
  premium_status, access_until, grace_until, created_at
`;

// ---------------------------------------------------------------------------
// reads
// ---------------------------------------------------------------------------

export async function listApplicants(
  db: Db,
  userId: string,
  locale: string,
): Promise<ApplicantListResponse> {
  const [rows, cfg] = await Promise.all([
    db.execute<ApplicantRowRaw>(sql`
      SELECT ${columns(locale)}
        FROM applicants a
        JOIN relationships r ON r.code = a.relationship_code
       WHERE a.user_id = ${userId} AND a.status = 'active'
       ORDER BY a.created_at
    `),
    readConfig(db, 'onboarding', ONBOARDING_CONFIG_FALLBACK),
  ]);

  return {
    applicants: rows.rows.map((r) => mapApplicant(r)),
    maxApplicants: cfg.max_applicants,
  };
}

/** 404 rather than 403 when the applicant belongs to someone else — never confirm existence. */
export async function getApplicant(
  db: Db,
  userId: string,
  applicantId: string,
  locale: string,
): Promise<Applicant> {
  const result = await db.execute<ApplicantRowRaw>(sql`
    SELECT ${columns(locale)}
      FROM applicants a
      JOIN relationships r ON r.code = a.relationship_code
     WHERE a.id = ${applicantId}::uuid AND a.user_id = ${userId} AND a.status = 'active'
  `);
  const row = result.rows[0];
  if (!row) throw AppError.notFound('Applicant not found.');
  return mapApplicant(row);
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

type RelationshipLookup = {
  code: string;
  category: RelationshipCategory;
  requires_dob: boolean;
  label: string;
}

async function loadRelationship(
  db: Db,
  code: string,
  locale: string,
): Promise<RelationshipLookup> {
  const result = await db.execute<RelationshipLookup>(sql`
    SELECT code, category, requires_dob,
           coalesce(labels->>${locale}, labels->>'en') AS label
      FROM relationships
     WHERE code = ${code} AND is_active
  `);
  const row = result.rows[0];
  if (!row) {
    throw AppError.validation({ relationshipCode: ['Not a selectable relationship.'] });
  }
  return row;
}

/**
 * Nulla Osta expiry: honour an explicit value, otherwise derive from the issue
 * date. Stored rather than computed on read so the Module 5 Cron reminder sweep
 * is a plain indexed date scan.
 *
 * PRD §14 requires validity to come from the latest verified requirement. Until
 * the CMS lands it comes from app_config — never a constant in code.
 */
function expiryExpression(
  issueDate: string | null | undefined,
  expiryDate: string | null | undefined,
  cfg: NullaOstaConfigValue,
): SQL {
  return sql`COALESCE(
    ${expiryDate ?? null}::date,
    CASE WHEN ${issueDate ?? null}::date IS NOT NULL
         THEN (${issueDate ?? null}::date + make_interval(months => ${cfg.validity_months}))::date
    END
  )`;
}

/** PRD §7 write gate. */
function assertWritable(row: ApplicantRowRaw): void {
  const access = resolveAccess(row);
  if (access.canWrite) return;
  throw AppError.applicantReadOnly(
    access.level === AccessLevel.GRACE_READ_ONLY
      ? 'This applicant is read-only during the grace period.'
      : 'Access for this applicant has ended. Request renewal to make changes.',
  );
}

async function loadForWrite(db: Db, userId: string, applicantId: string): Promise<ApplicantRowRaw> {
  const result = await db.execute<ApplicantRowRaw>(sql`
    SELECT ${RETURNING_COLUMNS}
      FROM applicants
     WHERE id = ${applicantId}::uuid AND user_id = ${userId} AND status = 'active'
     FOR UPDATE
  `);
  const row = result.rows[0];
  if (!row) throw AppError.notFound('Applicant not found.');
  assertWritable(row);
  return row;
}

// ---------------------------------------------------------------------------
// writes
// ---------------------------------------------------------------------------

/**
 * POST /v1/applicants — Screens §6.
 *
 * currentStage is optional during onboarding (Screen 7 sets it in a second
 * pass) but REQUIRED once onboarding is complete: onboarding_state never
 * regresses from 'complete', so a stageless applicant added later would
 * otherwise sit invisible to the Screen 7 flow forever.
 */
export async function createApplicant(
  db: Db,
  userId: string,
  input: CreateApplicantInput,
  locale: string,
): Promise<{ applicant: Applicant; onboardingState: OnboardingState }> {
  return db.transaction(async (tx) => {
    const gate = await tx.execute<{
      onboarding_state: OnboardingState;
      active_count: number;
      max_applicants: number;
    }>(sql`
      SELECT u.onboarding_state,
             (SELECT count(*)::int FROM applicants a
               WHERE a.user_id = u.id AND a.status = 'active')          AS active_count,
             COALESCE(
               (SELECT (value->>'max_applicants')::int FROM app_config WHERE key = 'onboarding'),
               ${ONBOARDING_CONFIG_FALLBACK.max_applicants}
             )                                                          AS max_applicants
        FROM users u
       WHERE u.id = ${userId} AND u.status = 'active'
    `);

    const g = gate.rows[0];
    if (!g) throw AppError.notFound('Account not found.');
    if (g.onboarding_state === OnboardingState.DISCLAIMER_PENDING) throw AppError.legalRequired();
    if (g.active_count >= g.max_applicants) throw AppError.applicantLimit(g.max_applicants);
    if (g.onboarding_state === OnboardingState.COMPLETE && !input.currentStage) {
      throw AppError.onboardingStep('currentStage is required when adding an applicant later.');
    }

    const rel = await loadRelationship(tx, input.relationshipCode, locale);
    if (rel.requires_dob && !input.dateOfBirth) {
      throw AppError.validation({
        dateOfBirth: [`Date of birth is required for ${rel.label}.`],
      });
    }

    const nullaCfg = await readConfig(tx, 'nulla_osta', NULLA_OSTA_CONFIG_FALLBACK);

    const inserted = await tx.execute<ApplicantRowRaw>(sql`
      INSERT INTO applicants (
        user_id, display_name, relationship_code, relationship_category,
        date_of_birth, current_location, current_stage, stage_updated_at,
        nulla_osta_status, nulla_osta_issue_date, nulla_osta_expiry_date
      ) VALUES (
        ${userId},
        ${input.displayName},
        ${rel.code},
        ${rel.category},
        ${input.dateOfBirth ?? null}::date,
        ${input.currentLocation},
        ${input.currentStage ?? null},
        CASE WHEN ${input.currentStage ?? null}::text IS NULL THEN NULL ELSE now() END,
        ${input.nullaOstaStatus ?? NullaOstaStatus.NOT_STARTED},
        ${input.nullaOstaIssueDate ?? null}::date,
        ${expiryExpression(input.nullaOstaIssueDate, input.nullaOstaExpiryDate, nullaCfg)}
      )
      RETURNING ${RETURNING_COLUMNS}
    `);

    const row = inserted.rows[0];
    if (!row) throw new Error('Applicant insert returned no row');

    if (input.currentStage) {
      await recordStageEvent(tx, row.id, null, input.currentStage);
      await generateCase(tx, row.id, {
        relationshipCategory: rel.category,
        currentStage: input.currentStage,
      });
    }

    return {
      applicant: mapApplicant(row, rel.label),
      onboardingState: await recomputeOnboardingState(tx, userId),
    };
  });
}

/**
 * PATCH /v1/applicants/:id — Screens §6 re-entry / §10 corrections.
 *
 * Changing the relationship changes the requirement category, which invalidates
 * any generated case. case_generated_at is reset to NULL so the Module 3 engine
 * regenerates instead of leaving the user on a checklist for the wrong category.
 */
export async function updateApplicant(
  db: Db,
  userId: string,
  applicantId: string,
  input: PatchApplicantInput,
  locale: string,
): Promise<Applicant> {
  return db.transaction(async (tx) => {
    const existing = await loadForWrite(tx, userId, applicantId);

    const sets: SQL[] = [];
    let rel: RelationshipLookup | null = null;
    let categoryChanged = false;

    if (input.relationshipCode !== undefined) {
      rel = await loadRelationship(tx, input.relationshipCode, locale);
      categoryChanged = rel.category !== existing.relationship_category;
      sets.push(sql`relationship_code = ${rel.code}`);
      sets.push(sql`relationship_category = ${rel.category}`);
      if (categoryChanged) sets.push(sql`case_generated_at = NULL`);

      const dob = input.dateOfBirth ?? existing.date_of_birth;
      if (rel.requires_dob && !dob) {
        throw AppError.validation({
          dateOfBirth: [`Date of birth is required for ${rel.label}.`],
        });
      }
    }

    if (input.displayName !== undefined) sets.push(sql`display_name = ${input.displayName}`);
    if (input.dateOfBirth !== undefined) {
      sets.push(sql`date_of_birth = ${input.dateOfBirth}::date`);
    }
    if (input.currentLocation !== undefined) {
      sets.push(sql`current_location = ${input.currentLocation}`);
    }
    if (input.nullaOstaStatus !== undefined) {
      sets.push(sql`nulla_osta_status = ${input.nullaOstaStatus}`);
    }
    if (input.nullaOstaIssueDate !== undefined || input.nullaOstaExpiryDate !== undefined) {
      const cfg = await readConfig(tx, 'nulla_osta', NULLA_OSTA_CONFIG_FALLBACK);
      const issue = input.nullaOstaIssueDate ?? existing.nulla_osta_issue_date;
      // An explicit expiry wins; otherwise re-derive from the (possibly new) issue date.
      const expiry =
        input.nullaOstaExpiryDate ??
        (input.nullaOstaIssueDate !== undefined ? null : existing.nulla_osta_expiry_date);
      sets.push(sql`nulla_osta_issue_date = ${issue ?? null}::date`);
      sets.push(sql`nulla_osta_expiry_date = ${expiryExpression(issue, expiry, cfg)}`);
    }

    // Stage changes go through setApplicantStage — it has to emit an event and
    // trigger case generation, which a generic PATCH must not do silently.
    if (input.currentStage !== undefined && input.currentStage !== existing.current_stage) {
      throw AppError.validation({
        currentStage: ['Use PATCH /v1/applicants/:id/stage to change the stage.'],
      });
    }

    if (sets.length === 0) return mapApplicant(existing, rel?.label);

    const updated = await tx.execute<ApplicantRowRaw>(sql`
      UPDATE applicants SET ${sql.join(sets, sql`, `)}
       WHERE id = ${applicantId}::uuid AND user_id = ${userId} AND status = 'active'
      RETURNING ${RETURNING_COLUMNS}
    `);

    const row = updated.rows[0];
    if (!row) throw AppError.notFound('Applicant not found.');

    if (categoryChanged && row.current_stage && rel) {
      await generateCase(tx, row.id, {
        relationshipCategory: rel.category,
        currentStage: row.current_stage,
        regenerate: true,
      });
    }

    return mapApplicant(row, rel?.label);
  });
}

async function recordStageEvent(
  db: Db,
  applicantId: string,
  fromStage: JourneyStage | null,
  toStage: JourneyStage,
): Promise<void> {
  await db.execute(sql`
    INSERT INTO applicant_stage_events (applicant_id, from_stage, to_stage, source)
    VALUES (${applicantId}::uuid, ${fromStage}, ${toStage}, 'user')
  `);
}

/**
 * PATCH /v1/applicants/:id/stage — Screens §7.
 *
 * Backward moves are allowed: the stage is self-reported and users mis-select.
 * Every move is recorded in applicant_stage_events, so a correction is visible
 * rather than destructive.
 */
export async function setApplicantStage(
  db: Db,
  userId: string,
  applicantId: string,
  stage: JourneyStage,
  locale: string,
): Promise<{ applicant: Applicant; onboardingState: OnboardingState }> {
  return db.transaction(async (tx) => {
    const existing = await loadForWrite(tx, userId, applicantId);

    if (existing.current_stage === stage) {
      return {
        applicant: await getApplicant(tx, userId, applicantId, locale),
        onboardingState: await recomputeOnboardingState(tx, userId),
      };
    }

    const updated = await tx.execute<ApplicantRowRaw>(sql`
      UPDATE applicants
         SET current_stage = ${stage}, stage_updated_at = now()
       WHERE id = ${applicantId}::uuid AND user_id = ${userId} AND status = 'active'
      RETURNING ${RETURNING_COLUMNS}
    `);
    const row = updated.rows[0];
    if (!row) throw AppError.notFound('Applicant not found.');

    await recordStageEvent(tx, row.id, existing.current_stage, stage);

    // Screens §7: the case must exist before the first Dashboard render, and it
    // must live or die with this stage write. Stub until Module 3.
    await generateCase(tx, row.id, {
      relationshipCategory: row.relationship_category,
      currentStage: stage,
    });

    return {
      applicant: await getApplicant(tx, userId, applicantId, locale),
      onboardingState: await recomputeOnboardingState(tx, userId),
    };
  });
}

/**
 * DELETE /v1/applicants/:id — soft delete (PRD §7 retains data).
 *
 * A paid applicant cannot be self-deleted: it would strand an order against an
 * invisible applicant and turn into a refund dispute. Support/admin path only.
 */
export async function deleteApplicant(
  db: Db,
  userId: string,
  applicantId: string,
): Promise<{ onboardingState: OnboardingState }> {
  return db.transaction(async (tx) => {
    const result = await tx.execute<{ premium_status: string }>(sql`
      SELECT premium_status FROM applicants
       WHERE id = ${applicantId}::uuid AND user_id = ${userId} AND status = 'active'
       FOR UPDATE
    `);
    const row = result.rows[0];
    if (!row) throw AppError.notFound('Applicant not found.');
    if (row.premium_status !== PremiumStatus.NONE) {
      throw AppError.conflict('This applicant has a purchase on record. Contact support to remove it.');
    }

    await tx.execute(sql`
      UPDATE applicants SET status = 'deleted', deleted_at = now()
       WHERE id = ${applicantId}::uuid AND user_id = ${userId}
    `);

    return { onboardingState: await recomputeOnboardingState(tx, userId) };
  });
}
