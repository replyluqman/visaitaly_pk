import { z } from 'zod';
import type { JourneyStage } from './applicant.types.js';
import type { Document } from './document.types.js';

/** Statuses the server stores and a client may write. `not_applicable` is derived. */
export const ItemStatus = {
  NOT_STARTED: 'not_started',
  IN_PROGRESS: 'in_progress',
  READY: 'ready',
  ISSUE_FOUND: 'issue_found',
} as const;
export type ItemStatus = (typeof ItemStatus)[keyof typeof ItemStatus];

/** What the client displays — the 4 stored statuses plus the derived `not_applicable` (PRD §12). */
export const ItemDisplayStatus = { ...ItemStatus, NOT_APPLICABLE: 'not_applicable' } as const;
export type ItemDisplayStatus = (typeof ItemDisplayStatus)[keyof typeof ItemDisplayStatus];

export const Badge = {
  BLOCKING: 'blocking',
  NEEDS_REVIEW: 'needs_review',
  SOURCE_UNDER_REVIEW: 'source_under_review',
} as const;
export type Badge = (typeof Badge)[keyof typeof Badge];

const writableStatus = z.enum([
  ItemStatus.NOT_STARTED,
  ItemStatus.IN_PROGRESS,
  ItemStatus.READY,
  ItemStatus.ISSUE_FOUND,
]);

export const patchChecklistItemSchema = z.object({
  status: writableStatus,
  /** requirementVersion the client last saw; omit when online. */
  baseVersion: z.number().int().min(1).max(1_000_000).optional(),
  /** When the user made the change on-device; omit when online. */
  clientMutationAt: z.string().datetime({ offset: true }).optional(),
});
export type PatchChecklistItemInput = z.infer<typeof patchChecklistItemSchema>;

const boolQuery = z
  .enum(['true', 'false'])
  .transform((v) => v === 'true')
  .optional();

export const checklistQuerySchema = z.object({
  since: z.string().datetime({ offset: true }).optional(),
  status: z
    .enum([...Object.values(ItemDisplayStatus)] as [ItemDisplayStatus, ...ItemDisplayStatus[]])
    .optional(),
  blocking: boolQuery,
  translation: boolQuery,
  apostille: boolQuery,
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type ChecklistQuery = z.infer<typeof checklistQuerySchema>;

export const checklistItemIdParamSchema = z.object({ id: z.string().uuid() });

export interface ChecklistItem {
  id: string;
  requirementCode: string;
  stage: JourneyStage;
  title: string;
  status: ItemDisplayStatus;
  badges: Badge[];
  notApplicableReason: string | null;
  translationRequired: boolean;
  apostilleRequired: boolean;
  lastVerifiedAt: string | null;
  requirementVersion: number;
  /** Always 0 until Module 3b adds documents. */
  documentCount: number;
  updatedAt: string;
}

export interface ChecklistItemDetail extends ChecklistItem {
  purpose: string | null;
  whoProvides: string | null;
  whereToObtain: string | null;
  recommendedTiming: string | null;
  conditionNote: string | null;
  source: {
    name: string;
    url: string;
    document: string | null;
    publishedAt: string | null;
  } | null;
  documents: Document[];
  canWrite: boolean;
}

export interface ChecklistResponse {
  applicantId: string;
  items: ChecklistItem[];
  /** Free tier: applicable items hidden behind the paywall ("+18 more documents"). */
  lockedCount: number;
  nextCursor: string | null;
  /** Pass as `since` on the next delta sync. Server clock, not the client's. */
  syncedAt: string;
}

export interface JourneyStageSummary {
  stage: JourneyStage;
  state: 'done' | 'current' | 'upcoming';
  itemCount: number;
  readyCount: number;
}

export interface JourneyResponse {
  currentStage: JourneyStage | null;
  stages: JourneyStageSummary[];
}

export interface Readiness {
  percent: number;
  applicableCount: number;
  readyCount: number;
  blockingCount: number;
  notApplicableCount: number;
  categorySpecificCount: number;
}
