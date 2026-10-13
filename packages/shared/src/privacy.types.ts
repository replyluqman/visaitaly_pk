import { z } from 'zod';

export const deleteAccountSchema = z.object({ confirm: z.literal(true) });

export const ConsentPurpose = {
  ANALYTICS: 'analytics',
  CRASH_REPORTS: 'crash_reports',
  MARKETING_PUSH: 'marketing_push',
} as const;
export type ConsentPurpose = (typeof ConsentPurpose)[keyof typeof ConsentPurpose];

export const consentsSchema = z
  .object({
    analytics: z.boolean().optional(),
    crashReports: z.boolean().optional(),
    marketingPush: z.boolean().optional(),
    /** The privacy-policy version the user was shown (DATA-PRIVACY §2: a new version re-asks). */
    policyVersion: z.string().trim().min(1).max(32),
  })
  .refine((o) => o.analytics !== undefined || o.crashReports !== undefined || o.marketingPush !== undefined, {
    message: 'No consents to update.',
  });
export type ConsentsInput = z.infer<typeof consentsSchema>;

export interface Consents {
  analytics: boolean;
  crashReports: boolean;
  marketingPush: boolean;
  policyVersion: string | null;
  /** false until the user has answered once — the client asks then. */
  answered: boolean;
}

export const dataRequestIdParamSchema = z.object({ id: z.string().uuid() });

export interface DataExportStatus {
  id: string;
  status: 'received' | 'processing' | 'completed' | 'rejected' | 'failed';
  requestedAt: string;
  completedAt: string | null;
  expiresAt: string | null;
  /** Short-lived capability URL; present only when the export is ready and has not expired. */
  downloadUrl: string | null;
}

export interface DeletionAccepted {
  requestId: string;
  status: 'received';
}

// ---- admin: legal manager (Screen 44) and case lookup (Screen 36) ----

export const createLegalVersionSchema = z.object({
  docType: z.enum(['disclaimer', 'terms', 'privacy']),
  locale: z.string().regex(/^[a-z]{2}$/).default('en'),
  version: z.string().trim().min(1).max(32),
  title: z.string().trim().min(1).max(200),
  bodyMd: z.string().trim().min(1).max(200_000),
  isMandatory: z.boolean().default(true),
});
export type CreateLegalVersionInput = z.infer<typeof createLegalVersionSchema>;

export const patchLegalVersionSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    bodyMd: z.string().trim().min(1).max(200_000).optional(),
    isMandatory: z.boolean().optional(),
  })
  .refine((o) => Object.keys(o).length > 0, { message: 'No fields to update.' });
export type PatchLegalVersionInput = z.infer<typeof patchLegalVersionSchema>;

export const legalListQuerySchema = z.object({
  docType: z.enum(['disclaimer', 'terms', 'privacy']).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const lookupQuerySchema = z
  .object({
    email: z.string().trim().toLowerCase().email().max(254).optional(),
    userId: z.string().uuid().optional(),
  })
  .refine((o) => Number(o.email !== undefined) + Number(o.userId !== undefined) === 1, {
    message: 'Provide exactly one of email or userId.',
  });
export type LookupQuery = z.infer<typeof lookupQuerySchema>;

export interface AdminLegalVersion {
  id: string;
  docType: 'disclaimer' | 'terms' | 'privacy';
  locale: string;
  version: string;
  title: string;
  isMandatory: boolean;
  isCurrent: boolean;
  publishedAt: string | null;
  publishedBy: string | null;
  acceptanceCount: number;
  createdAt: string;
}

export interface LegalAcceptanceRecord {
  userId: string;
  acceptedAt: string;
  appVersion: string | null;
}

export interface CaseLookup {
  user: {
    id: string; email: string | null; displayName: string | null; status: string;
    onboardingState: string; createdAt: string; lastLoginAt: string | null;
  };
  applicants: Array<{
    id: string; displayName: string; relationshipCode: string; currentStage: string | null;
    premiumStatus: string; accessUntil: string | null; graceUntil: string | null;
    readiness: { applicable: number; ready: number; blocking: number };
  }>;
  devices: Array<{ platform: string; model: string | null; appVersion: string | null; status: string; lastSeenAt: string }>;
  legalAcceptances: Array<{ docType: string; version: string; acceptedAt: string }>;
  dataRequests: Array<{ kind: string; status: string; requestedAt: string }>;
}
