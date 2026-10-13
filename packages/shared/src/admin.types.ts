import { z } from 'zod';

/** PRD §16. `super_admin` is the `isSuper` flag, not a scope. */
export const AdminScope = {
  PAYMENT_APPROVE: 'payment_approve',
  TRANSLATION_MANAGE: 'translation_manage',
  APPOINTMENT_MANAGE: 'appointment_manage',
  VERIFICATION_MANAGE: 'verification_manage',
  REFERRAL_PAYOUT: 'referral_payout',
  CASH_DEPT: 'cash_dept',
  PRICING_CONFIG: 'pricing_config',
  LEGAL_MANAGE: 'legal_manage',
  EXPIRY_MANAGE: 'expiry_manage',
  SUPPORT_MANAGE: 'support_manage',
  REFUND_MANAGE: 'refund_manage',
  READ_ONLY: 'read_only',
} as const;
export type AdminScope = (typeof AdminScope)[keyof typeof AdminScope];
export const ADMIN_SCOPES = Object.values(AdminScope) as [AdminScope, ...AdminScope[]];

const scopeEnum = z.enum(ADMIN_SCOPES);

export const createAdminSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  displayName: z.string().trim().min(1).max(80).optional(),
  isSuper: z.boolean().default(false),
  scopes: z.array(scopeEnum).max(ADMIN_SCOPES.length).default([]),
});
export type CreateAdminInput = z.infer<typeof createAdminSchema>;

export const patchAdminSchema = z
  .object({
    displayName: z.string().trim().min(1).max(80).optional(),
    status: z.enum(['active', 'disabled']).optional(),
    isSuper: z.boolean().optional(),
    /** Replaces the whole scope set. */
    scopes: z.array(scopeEnum).max(ADMIN_SCOPES.length).optional(),
  })
  .refine((o) => Object.keys(o).length > 0, { message: 'No fields to update.' });
export type PatchAdminInput = z.infer<typeof patchAdminSchema>;

export const adminIdParamSchema = z.object({ id: z.string().uuid() });

export const auditQuerySchema = z.object({
  actorId: z.string().uuid().optional(),
  action: z.string().max(64).optional(),
  targetType: z.string().max(64).optional(),
  targetId: z.string().max(64).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type AuditQuery = z.infer<typeof auditQuerySchema>;

export interface AdminProfile {
  id: string;
  email: string;
  displayName: string | null;
  isSuper: boolean;
  status: 'active' | 'disabled';
  scopes: AdminScope[];
  linked: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface AdminList {
  items: AdminProfile[];
  nextCursor: string | null;
}

export interface AuditEntry {
  id: string;
  actorType: 'admin' | 'user' | 'system';
  actorId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, unknown>;
  requestId: string | null;
  createdAt: string;
}

export interface AuditList {
  items: AuditEntry[];
  nextCursor: string | null;
}
