import { z } from 'zod';

/** PRD §18 disclaimer placement. Only 'disclaimer' blocks onboarding today. */
export const LegalDocType = {
  DISCLAIMER: 'disclaimer',
  TERMS: 'terms',
  PRIVACY: 'privacy',
} as const;
export type LegalDocType = (typeof LegalDocType)[keyof typeof LegalDocType];

// ---------- requests ----------

/**
 * POST /v1/legal/accept
 * Client sends the ids it was shown, so a version published mid-session cannot
 * be silently marked accepted. The server rejects any id that is not current.
 */
export const acceptLegalSchema = z.object({
  versionIds: z.array(z.string().uuid()).min(1).max(10),
  /** Recorded on the acceptance row for audit. */
  appVersion: z.string().max(32).optional(),
});
export type AcceptLegalInput = z.infer<typeof acceptLegalSchema>;

export const legalDocTypeParamSchema = z.object({
  docType: z.enum([LegalDocType.DISCLAIMER, LegalDocType.TERMS, LegalDocType.PRIVACY]),
});

// ---------- responses ----------

/** Metadata only — no body. Screen 4 fetches the body separately. */
export interface LegalVersionSummary {
  id: string;
  docType: LegalDocType;
  locale: string;
  version: string;
  title: string;
  isMandatory: boolean;
  publishedAt: string | null;
  /** True if this user has already accepted this (docType, version). */
  accepted: boolean;
}

/** GET /v1/legal/current */
export interface CurrentLegalResponse {
  documents: LegalVersionSummary[];
  /** True while any mandatory current document is unaccepted. */
  requiresAcceptance: boolean;
}

/** GET /v1/legal/current/:docType */
export interface LegalDocumentResponse extends LegalVersionSummary {
  bodyMd: string;
}
