import { z } from 'zod';

/** Locale-keyed copy; English is mandatory (PRD §11a: English-first). */
export const localizedText = z
  .record(z.string().regex(/^[a-z]{2}$/), z.string().trim().min(1).max(2000))
  .refine((o) => typeof o.en === 'string', { message: 'An English (en) value is required.' });

const stageEnum = z.enum([
  'eligibility', 'nulla_osta', 'documents', 'translation', 'appointment', 'application', 'processing', 'decision',
]);
const locationEnum = z.enum(['pakistan', 'italy', 'other']);
const nullaEnum = z.enum(['not_applicable', 'not_started', 'in_process', 'received']);
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected format YYYY-MM-DD.')
  .refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)), 'Not a valid date.');

export const RequirementStatus = {
  CREATED: 'created',
  VERIFIED: 'verified',
  PUBLISHED: 'published',
  ARCHIVED: 'archived',
} as const;
export type RequirementStatus = (typeof RequirementStatus)[keyof typeof RequirementStatus];

const content = {
  stage: stageEnum,
  title: localizedText,
  purpose: localizedText.nullable(),
  whoProvides: localizedText.nullable(),
  whereToObtain: localizedText.nullable(),
  recommendedTiming: localizedText.nullable(),
  conditionNote: localizedText.nullable(),
  naReason: localizedText.nullable(),
  appliesSpouse: z.boolean(),
  appliesChild: z.boolean(),
  appliesParent: z.boolean(),
  appliesLocations: z.array(locationEnum).min(1).max(3).nullable(),
  minAgeYears: z.number().int().min(0).max(120).nullable(),
  maxAgeYears: z.number().int().min(0).max(120).nullable(),
  requiresNullaOstaStatus: z.array(nullaEnum).min(1).max(4).nullable(),
  isConditional: z.boolean(),
  translationRequired: z.boolean(),
  apostilleRequired: z.boolean(),
  blocksSubmission: z.boolean(),
  validityDays: z.number().int().min(1).max(3650).nullable(),
  sourceId: z.string().uuid().nullable(),
  sourceDocument: z.string().trim().min(1).max(200).nullable(),
  sourcePublishedAt: isoDate.nullable(),
  sortOrder: z.number().int().min(0).max(100000),
};

const ageOrder = (o: { minAgeYears?: number | null; maxAgeYears?: number | null }) =>
  o.minAgeYears == null || o.maxAgeYears == null || o.minAgeYears <= o.maxAgeYears;

export const createRequirementSchema = z
  .object({
    code: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/, 'Lower-case letters, digits and underscores.'),
    stage: content.stage,
    title: content.title,
    purpose: content.purpose.optional(),
    whoProvides: content.whoProvides.optional(),
    whereToObtain: content.whereToObtain.optional(),
    recommendedTiming: content.recommendedTiming.optional(),
    conditionNote: content.conditionNote.optional(),
    naReason: content.naReason.optional(),
    appliesSpouse: content.appliesSpouse.default(true),
    appliesChild: content.appliesChild.default(true),
    appliesParent: content.appliesParent.default(true),
    appliesLocations: content.appliesLocations.optional(),
    minAgeYears: content.minAgeYears.optional(),
    maxAgeYears: content.maxAgeYears.optional(),
    requiresNullaOstaStatus: content.requiresNullaOstaStatus.optional(),
    isConditional: content.isConditional.default(false),
    translationRequired: content.translationRequired.default(false),
    apostilleRequired: content.apostilleRequired.default(false),
    blocksSubmission: content.blocksSubmission.default(false),
    validityDays: content.validityDays.optional(),
    sourceId: content.sourceId.optional(),
    sourceDocument: content.sourceDocument.optional(),
    sourcePublishedAt: content.sourcePublishedAt.optional(),
    sortOrder: content.sortOrder.default(0),
  })
  .refine(ageOrder, { message: 'minAgeYears cannot exceed maxAgeYears.', path: ['minAgeYears'] });
export type CreateRequirementInput = z.infer<typeof createRequirementSchema>;

export const patchRequirementSchema = z
  .object({
    stage: content.stage.optional(),
    title: content.title.optional(),
    purpose: content.purpose.optional(),
    whoProvides: content.whoProvides.optional(),
    whereToObtain: content.whereToObtain.optional(),
    recommendedTiming: content.recommendedTiming.optional(),
    conditionNote: content.conditionNote.optional(),
    naReason: content.naReason.optional(),
    appliesSpouse: content.appliesSpouse.optional(),
    appliesChild: content.appliesChild.optional(),
    appliesParent: content.appliesParent.optional(),
    appliesLocations: content.appliesLocations.optional(),
    minAgeYears: content.minAgeYears.optional(),
    maxAgeYears: content.maxAgeYears.optional(),
    requiresNullaOstaStatus: content.requiresNullaOstaStatus.optional(),
    isConditional: content.isConditional.optional(),
    translationRequired: content.translationRequired.optional(),
    apostilleRequired: content.apostilleRequired.optional(),
    blocksSubmission: content.blocksSubmission.optional(),
    validityDays: content.validityDays.optional(),
    sourceId: content.sourceId.optional(),
    sourceDocument: content.sourceDocument.optional(),
    sourcePublishedAt: content.sourcePublishedAt.optional(),
    sortOrder: content.sortOrder.optional(),
    /**
     * Required to edit a PUBLISHED requirement: asserts the admin has re-checked the source, and
     * re-stamps verification in the same step (PRD §13: critical requirements can never change
     * without updating their verification record).
     */
    reverify: z.boolean().optional(),
    /** What changed, shown to users in the Updates feed. Required with `reverify`. */
    changeSummary: localizedText.optional(),
  })
  .refine((o) => Object.keys(o).length > 0, { message: 'No fields to update.' })
  .refine(ageOrder, { message: 'minAgeYears cannot exceed maxAgeYears.', path: ['minAgeYears'] });
export type PatchRequirementInput = z.infer<typeof patchRequirementSchema>;

export const requirementActionSchema = z.object({
  action: z.enum(['verify', 'publish', 'unpublish', 'archive', 'reverify']),
  /** User-facing "what changed" for a re-publication; optional on first publish. */
  changeSummary: localizedText.optional(),
});
export type RequirementActionInput = z.infer<typeof requirementActionSchema>;

export const requirementListQuerySchema = z.object({
  status: z.enum(['created', 'verified', 'published', 'archived']).optional(),
  stage: stageEnum.optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type RequirementListQuery = z.infer<typeof requirementListQuerySchema>;

export const createSourceSchema = z.object({
  url: z
    .string()
    .trim()
    .max(2000)
    .url()
    .refine((u) => u.startsWith('https://'), { message: 'Only https:// sources are accepted.' }),
  name: localizedText,
  authority: z.enum(['embassy', 'government', 'service_provider']),
});
export type CreateSourceInput = z.infer<typeof createSourceSchema>;

export const patchSourceSchema = z
  .object({
    name: localizedText.optional(),
    authority: z.enum(['embassy', 'government', 'service_provider']).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((o) => Object.keys(o).length > 0, { message: 'No fields to update.' });
export type PatchSourceInput = z.infer<typeof patchSourceSchema>;

export const resolveFlagSchema = z.object({
  action: z.enum(['reverified', 'dismissed']),
  note: z.string().trim().min(1).max(1000).optional(),
});
export type ResolveFlagInput = z.infer<typeof resolveFlagSchema>;

export const cmsListQuerySchema = z.object({
  status: z.enum(['open', 'resolved', 'dismissed']).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type CmsListQuery = z.infer<typeof cmsListQuerySchema>;

export const cmsIdParamSchema = z.object({ id: z.string().uuid() });

export interface AdminSource {
  id: string;
  url: string;
  name: Record<string, string>;
  authority: 'embassy' | 'government' | 'service_provider';
  isActive: boolean;
  lastCheckedAt: string | null;
  lastChangedAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
  openFlag: boolean;
  createdAt: string;
}

export interface AdminRequirement {
  id: string;
  code: string;
  stage: string;
  status: RequirementStatus;
  version: number;
  title: Record<string, string>;
  purpose: Record<string, string> | null;
  whoProvides: Record<string, string> | null;
  whereToObtain: Record<string, string> | null;
  recommendedTiming: Record<string, string> | null;
  conditionNote: Record<string, string> | null;
  naReason: Record<string, string> | null;
  appliesSpouse: boolean;
  appliesChild: boolean;
  appliesParent: boolean;
  appliesLocations: string[] | null;
  minAgeYears: number | null;
  maxAgeYears: number | null;
  requiresNullaOstaStatus: string[] | null;
  isConditional: boolean;
  translationRequired: boolean;
  apostilleRequired: boolean;
  blocksSubmission: boolean;
  validityDays: number | null;
  sourceId: string | null;
  sourceDocument: string | null;
  sourcePublishedAt: string | null;
  sortOrder: number;
  lastVerifiedAt: string | null;
  lastVerifiedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AdminRequirementSummary {
  id: string;
  code: string;
  stage: string;
  status: RequirementStatus;
  version: number;
  title: string;
  sourceId: string | null;
  lastVerifiedAt: string | null;
  openFlag: boolean;
}

export interface RequirementVersionEntry {
  version: number;
  effectiveDate: string;
  publishedAt: string;
  publishedBy: string;
  changeSummary: Record<string, string> | null;
}

export interface SourceFlag {
  id: string;
  sourceId: string;
  sourceUrl: string;
  status: 'open' | 'resolved' | 'dismissed';
  detectedAt: string;
  resolvedAt: string | null;
  resolutionNote: string | null;
  affectedRequirements: number;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface VerificationSummary {
  requirementsTracked: number;
  sourceLinkedPercent: number;
  lastSweepAt: string | null;
  openFlags: number;
  recentUpdates: Array<{ requirementTitle: string; changeSummary: string | null; effectiveDate: string }>;
}
