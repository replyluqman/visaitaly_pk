import { z } from 'zod';
import type { Readiness } from './checklist.types.js';

/**
 * Requirement category (PRD §2). Locked product structure — the rule engine
 * keys off exactly these three. Derived server-side from relationshipCode;
 * clients never send it.
 */
export const RelationshipCategory = {
  SPOUSE: 'spouse',
  CHILD: 'child',
  PARENT: 'parent',
} as const;
export type RelationshipCategory =
  (typeof RelationshipCategory)[keyof typeof RelationshipCategory];

/** Rule-engine input: where the applicant physically is (Screens §6). */
export const ApplicantLocation = {
  PAKISTAN: 'pakistan',
  ITALY: 'italy',
  OTHER: 'other',
} as const;
export type ApplicantLocation = (typeof ApplicantLocation)[keyof typeof ApplicantLocation];

/**
 * The eight canonical journey stages (PRD §12). Screen 7's selector maps onto
 * these plus nullaOstaStatus — "Nulla Osta in process" and "received" are the
 * same stage with different tracker state, not two stages.
 *
 * This list is structure, not a tunable value: adding a stage changes the
 * journey engine and the timeline UI, i.e. it is a release, so it does not
 * belong in app_config.
 */
export const JourneyStage = {
  ELIGIBILITY: 'eligibility',
  NULLA_OSTA: 'nulla_osta',
  DOCUMENTS: 'documents',
  TRANSLATION: 'translation',
  APPOINTMENT: 'appointment',
  APPLICATION: 'application',
  PROCESSING: 'processing',
  DECISION: 'decision',
} as const;
export type JourneyStage = (typeof JourneyStage)[keyof typeof JourneyStage];

/** Ordered. Screens §12 renders the timeline from this; index = progress. */
export const STAGE_SEQUENCE: readonly JourneyStage[] = [
  JourneyStage.ELIGIBILITY,
  JourneyStage.NULLA_OSTA,
  JourneyStage.DOCUMENTS,
  JourneyStage.TRANSLATION,
  JourneyStage.APPOINTMENT,
  JourneyStage.APPLICATION,
  JourneyStage.PROCESSING,
  JourneyStage.DECISION,
] as const;

export const NullaOstaStatus = {
  NOT_APPLICABLE: 'not_applicable',
  NOT_STARTED: 'not_started',
  IN_PROCESS: 'in_process',
  RECEIVED: 'received',
} as const;
export type NullaOstaStatus = (typeof NullaOstaStatus)[keyof typeof NullaOstaStatus];

/** PRD §7. Written by the orders + expiry modules, read everywhere. */
export const PremiumStatus = {
  NONE: 'none',
  ACTIVE: 'active',
  EXPIRED_PENDING_CONFIRMATION: 'expired_pending_confirmation',
  EXPIRED: 'expired',
} as const;
export type PremiumStatus = (typeof PremiumStatus)[keyof typeof PremiumStatus];

/** What the client actually branches on per applicant (Screens §8/§10 states). */
export const AccessLevel = {
  /** Free tier — writable, feature-gated by the checklist module. */
  FREE: 'free',
  PREMIUM: 'premium',
  /** Grace period: read everything, write nothing (PRD §7). */
  GRACE_READ_ONLY: 'grace_read_only',
  EXPIRED: 'expired',
} as const;
export type AccessLevel = (typeof AccessLevel)[keyof typeof AccessLevel];

// ---------- shared field schemas ----------

/**
 * YYYY-MM-DD, must be a real date, must not be in the future.
 * Written as a regex + refine rather than z.string().date() so this does not
 * depend on the installed zod minor version.
 */
const pastIsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected format YYYY-MM-DD.')
  .refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)), 'Not a valid date.')
  .refine((v) => Date.parse(`${v}T00:00:00Z`) <= Date.now(), 'Cannot be in the future.');

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected format YYYY-MM-DD.')
  .refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)), 'Not a valid date.');

const stageEnum = z.enum([
  JourneyStage.ELIGIBILITY,
  JourneyStage.NULLA_OSTA,
  JourneyStage.DOCUMENTS,
  JourneyStage.TRANSLATION,
  JourneyStage.APPOINTMENT,
  JourneyStage.APPLICATION,
  JourneyStage.PROCESSING,
  JourneyStage.DECISION,
]);

const nullaOstaStatusEnum = z.enum([
  NullaOstaStatus.NOT_APPLICABLE,
  NullaOstaStatus.NOT_STARTED,
  NullaOstaStatus.IN_PROCESS,
  NullaOstaStatus.RECEIVED,
]);

// ---------- requests ----------

/** PATCH /v1/onboarding/applicant-count — Screens §5. */
export const applicantCountSchema = z.object({
  declaredApplicantCount: z.number().int().min(1).max(99),
});
export type ApplicantCountInput = z.infer<typeof applicantCountSchema>;

/**
 * POST /v1/applicants — Screens §6.
 * dateOfBirth is conditionally required: the service checks it against
 * relationships.requires_dob, which zod cannot see. `currentStage` is optional
 * during onboarding (Screen 7 sets it) and REQUIRED once onboarding is complete,
 * enforced in the service.
 */
export const createApplicantSchema = z.object({
  displayName: z.string().trim().min(1).max(80),
  relationshipCode: z.string().trim().min(1).max(32),
  dateOfBirth: pastIsoDate.optional(),
  currentLocation: z.enum([
    ApplicantLocation.PAKISTAN,
    ApplicantLocation.ITALY,
    ApplicantLocation.OTHER,
  ]),
  nullaOstaStatus: nullaOstaStatusEnum.optional(),
  nullaOstaIssueDate: pastIsoDate.optional(),
  /** Omit to let the server derive it from issue date + configured validity. */
  nullaOstaExpiryDate: isoDate.optional(),
  currentStage: stageEnum.optional(),
});
export type CreateApplicantInput = z.infer<typeof createApplicantSchema>;

/** PATCH /v1/applicants/:id — at least one field. */
export const patchApplicantSchema = createApplicantSchema
  .partial()
  .refine((o) => Object.keys(o).length > 0, { message: 'No fields to update.' });
export type PatchApplicantInput = z.infer<typeof patchApplicantSchema>;

/** PATCH /v1/applicants/:id/stage — Screens §7. */
export const setStageSchema = z.object({ currentStage: stageEnum });
export type SetStageInput = z.infer<typeof setStageSchema>;

export const applicantIdParamSchema = z.object({ id: z.string().uuid() });

// ---------- responses ----------

/** GET /v1/reference/relationships — CMS-driven, cache client-side. */
export interface RelationshipOption {
  code: string;
  label: string;
  category: RelationshipCategory;
  requiresDob: boolean;
}

export interface NullaOsta {
  status: NullaOstaStatus;
  issueDate: string | null;
  expiryDate: string | null;
  /** Negative once expired. Null when no expiry is known. */
  daysRemaining: number | null;
}

export interface Applicant {
  id: string;
  displayName: string;
  relationshipCode: string;
  relationshipLabel: string;
  relationshipCategory: RelationshipCategory;
  dateOfBirth: string | null;
  currentLocation: ApplicantLocation;
  currentStage: JourneyStage | null;
  stageUpdatedAt: string | null;
  /** Null until the checklist engine has generated the case (Module 3). */
  caseGeneratedAt: string | null;
  nullaOsta: NullaOsta;
  access: {
    level: AccessLevel;
    /** False during grace and after expiry (PRD §7). */
    canWrite: boolean;
    accessUntil: string | null;
    graceUntil: string | null;
  };
  /** Derived, never stored (invariant 8). All zeros until a case is generated. */
  readiness: Readiness;
  createdAt: string;
}

export interface ApplicantListResponse {
  applicants: Applicant[];
  /** From app_config.onboarding.max_applicants, not hardcoded. */
  maxApplicants: number;
}
