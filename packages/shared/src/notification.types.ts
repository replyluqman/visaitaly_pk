import { z } from 'zod';

export const NotificationTab = { REMINDER: 'reminder', UPDATE: 'update', ACTIVITY: 'activity' } as const;
export type NotificationTab = (typeof NotificationTab)[keyof typeof NotificationTab];
const tabEnum = z.enum([NotificationTab.REMINDER, NotificationTab.UPDATE, NotificationTab.ACTIVITY]);

export const notificationListQuerySchema = z.object({
  tab: tabEnum,
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type NotificationListQuery = z.infer<typeof notificationListQuerySchema>;

export const readAllSchema = z.object({ tab: tabEnum.optional() });

export const notificationIdParamSchema = z.object({ id: z.string().uuid() });

export const notificationPreferencesSchema = z
  .object({
    push: z
      .object({ reminder: z.boolean().optional(), update: z.boolean().optional(), activity: z.boolean().optional() })
      .strict(),
  })
  .refine((o) => Object.keys(o.push).length > 0, { message: 'No preferences to update.' });
export type NotificationPreferencesInput = z.infer<typeof notificationPreferencesSchema>;

export interface Notification {
  id: string;
  tab: NotificationTab;
  type: string;
  title: string;
  body: string;
  /** App-relative path; mandatory on every notification (PRD §14 rule 3). */
  deepLink: string;
  applicantId: string | null;
  createdAt: string;
  readAt: string | null;
}

export interface NotificationList {
  items: Notification[];
  nextCursor: string | null;
}

export interface UnreadCount {
  total: number;
  byTab: { reminder: number; update: number; activity: number };
}

export interface NotificationPreferences {
  push: { reminder: boolean; update: boolean; activity: boolean };
}
