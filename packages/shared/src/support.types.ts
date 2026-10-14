import { z } from 'zod';

export const SupportTopic = {
  PAYMENT: 'payment',
  ORDER: 'order',
  COURIER: 'courier',
  REFUND: 'refund',
  ACCOUNT: 'account',
  APP_PROBLEM: 'app_problem',
  PRESALES: 'presales',
} as const;
export type SupportTopic = (typeof SupportTopic)[keyof typeof SupportTopic];
export const SUPPORT_TOPICS = Object.values(SupportTopic) as [SupportTopic, ...SupportTopic[]];
const topicEnum = z.enum(SUPPORT_TOPICS);

export type SupportThreadStatus = 'open' | 'awaiting_support' | 'awaiting_user' | 'closed';

// ---- user ----
export const sendSupportMessageSchema = z
  .object({
    body: z.string().trim().max(4000).default(''),
    topic: topicEnum,
    applicantId: z.string().uuid().optional(),
    attachmentId: z.string().uuid().optional(),
  })
  .refine((o) => o.body.length > 0 || o.attachmentId !== undefined, {
    message: 'Write a message or attach an image.',
    path: ['body'],
  });
export type SendSupportMessageInput = z.infer<typeof sendSupportMessageSchema>;

export const attachmentUploadSchema = z.object({
  mime: z.enum(['image/jpeg', 'image/png']),
  sizeBytes: z.number().int().min(1).max(50_000_000),
});
export type AttachmentUploadInput = z.infer<typeof attachmentUploadSchema>;

export const supportMessagesQuerySchema = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(30),
});

export const supportIdParamSchema = z.object({ id: z.string().uuid() });

export interface SupportThreadView {
  /** 'none' until the first message. */
  status: SupportThreadStatus | 'none';
  tier: 'free' | 'paid';
  /** The promise: when support will have replied by (working-hours computed). Null unless awaiting support. */
  slaDueAt: string | null;
  unreadCount: number;
  /** Shown beside every SLA statement (PRD §14a rule 2); null until an admin sets it in the CMS. */
  workingHoursText: string | null;
  /** Topics this account may use (tier-dependent). */
  allowedTopics: SupportTopic[];
}

export interface SupportMessage {
  id: string;
  senderType: 'user' | 'admin' | 'system';
  body: string;
  topic: SupportTopic | null;
  applicantId: string | null;
  attachment: { id: string; mime: string } | null;
  createdAt: string;
  readByUserAt: string | null;
}

export interface SupportMessageList {
  items: SupportMessage[];
  nextCursor: string | null;
}

export interface SupportAttachmentUpload {
  id: string;
  uploadUrl: string;
  expiresAt: string;
  requiredHeaders: Record<string, string>;
}

// ---- admin ----
export const adminThreadListSchema = z.object({
  status: z.enum(['open', 'awaiting_support', 'awaiting_user', 'closed']).default('awaiting_support'),
  assignee: z.enum(['me', 'unassigned']).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const adminReplySchema = z
  .object({
    /** A CMS canned response — the way requirement questions are answered (PRD §10). */
    cannedResponseId: z.string().uuid().optional(),
    /** Free text, for in-scope topics only; screened against the verdict-language rules. */
    body: z.string().trim().min(1).max(4000).optional(),
    topic: topicEnum.optional(),
  })
  .refine((o) => (o.cannedResponseId !== undefined) !== (o.body !== undefined), {
    message: 'Send either a canned response or free text, not both.',
  });
export type AdminReplyInput = z.infer<typeof adminReplySchema>;

export const assignSchema = z.object({ adminId: z.string().uuid().nullable() });

export const cannedLocalized = z
  .record(z.string().regex(/^[a-z]{2}$/), z.string().trim().min(1).max(2000))
  .refine((o) => typeof o.en === 'string', { message: 'An English (en) value is required.' });

export const createCannedSchema = z.object({
  code: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/),
  title: z.string().trim().min(1).max(120),
  body: cannedLocalized,
  topic: topicEnum.nullable().optional(),
  requirementId: z.string().uuid().nullable().optional(),
});
export type CreateCannedInput = z.infer<typeof createCannedSchema>;

export const patchCannedSchema = z
  .object({
    title: z.string().trim().min(1).max(120).optional(),
    body: cannedLocalized.optional(),
    topic: topicEnum.nullable().optional(),
    requirementId: z.string().uuid().nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .refine((o) => Object.keys(o).length > 0, { message: 'No fields to update.' });
export type PatchCannedInput = z.infer<typeof patchCannedSchema>;

export interface AdminThreadSummary {
  id: string;
  userId: string;
  status: SupportThreadStatus;
  tier: 'free' | 'paid';
  slaDueAt: string | null;
  /** True when awaiting support and past the deadline — highlighted on Admin Home. */
  breached: boolean;
  assignedAdminId: string | null;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
}

export interface AdminThreadDetail {
  thread: AdminThreadSummary;
  /** Side panel: enough context that the operator never has to fetch it (Screens §35). */
  context: {
    email: string | null;
    applicants: Array<{ id: string; relationshipCode: string; currentStage: string | null; premiumStatus: string }>;
  };
  messages: Array<SupportMessage & { adminId: string | null; cannedResponseId: string | null }>;
  nextCursor: string | null;
}

export interface CannedResponse {
  id: string;
  code: string;
  title: string;
  body: Record<string, string>;
  topic: SupportTopic | null;
  requirementId: string | null;
  isActive: boolean;
  updatedAt: string;
}

export interface SupportSummary {
  awaitingSupport: number;
  breached: number;
  unassigned: number;
}
