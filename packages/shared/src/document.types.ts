import { z } from 'zod';
import type { JourneyStage } from './applicant.types.js';

export const DocumentMime = {
  JPEG: 'image/jpeg',
  PNG: 'image/png',
  PDF: 'application/pdf',
} as const;
export type DocumentMime = (typeof DocumentMime)[keyof typeof DocumentMime];

export const DocumentStatus = { PENDING: 'pending', ACTIVE: 'active', DELETED: 'deleted' } as const;

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected format YYYY-MM-DD.')
  .refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)), 'Not a valid date.');

export const uploadUrlSchema = z.object({
  mime: z.enum([DocumentMime.JPEG, DocumentMime.PNG, DocumentMime.PDF]),
  sizeBytes: z.number().int().min(1).max(1_073_741_824),
  sha256: z.string().regex(/^[a-f0-9]{64}$/, 'Expected a lowercase hex SHA-256.'),
  applicantId: z.string().uuid(),
  checklistItemId: z.string().uuid().optional(),
  expiryDate: isoDate.optional(),
});
export type UploadUrlInput = z.infer<typeof uploadUrlSchema>;

export const documentListQuerySchema = z.object({
  applicantId: z.string().uuid().optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type DocumentListQuery = z.infer<typeof documentListQuerySchema>;

export const documentIdParamSchema = z.object({ id: z.string().uuid() });

export interface UploadUrlResponse {
  id: string;
  uploadUrl: string;
  expiresAt: string;
  /** Headers the client MUST send with the PUT, exactly as given. */
  requiredHeaders: Record<string, string>;
}

export interface Document {
  id: string;
  applicantId: string;
  checklistItemId: string | null;
  mime: DocumentMime;
  sizeBytes: number;
  expiryDate: string | null;
  createdAt: string;
  /** Short-lived signed GET. Present on detail only. */
  viewUrl: string | null;
}

export interface DocumentList {
  items: Document[];
  nextCursor: string | null;
  quota: { usedBytes: number; maxBytes: number };
}

export const TodayKind = {
  EXPIRING: 'expiring',
  BLOCKING: 'blocking',
  TODO: 'todo',
} as const;
export type TodayKind = (typeof TodayKind)[keyof typeof TodayKind];

/** Why the action is listed. The client composes the sentence; the server holds no English. */
export const TodayReason = {
  DOCUMENT_EXPIRES: 'document_expires',
  NULLA_OSTA_EXPIRES: 'nulla_osta_expires',
  BLOCKS_SUBMISSION: 'blocks_submission',
  ISSUE_FOUND: 'issue_found',
  IN_PROGRESS: 'in_progress',
  NOT_STARTED: 'not_started',
} as const;
export type TodayReason = (typeof TodayReason)[keyof typeof TodayReason];

export interface TodayAction {
  kind: TodayKind;
  reason: TodayReason;
  /** CMS requirement title; null for applicant-level actions (Nulla Osta expiry). */
  title: string | null;
  applicantId: string;
  itemId: string | null;
  dueDate: string | null;
  /** App-relative path, e.g. `/checklist/<id>` or `/applicants/<id>`. */
  deepLink: string;
}

export interface TodayResponse {
  actions: TodayAction[];
  /** Present only when there is nothing to do. */
  allClear: { nextStage: JourneyStage | null } | null;
  computedAt: string | null;
}
