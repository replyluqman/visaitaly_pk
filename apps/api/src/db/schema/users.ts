import { pgTable, uuid, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    firebaseUid: text('firebase_uid').notNull(),
    email: text('email'),
    displayName: text('display_name'),
    /** disclaimer_pending | applicants_pending | stage_pending | complete */
    onboardingState: text('onboarding_state').notNull().default('disclaimer_pending'),
    /** active | deleted (GDPR soft delete — rows retained, PII cleared) */
    status: text('status').notNull().default('active'),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    firebaseUidUq: uniqueIndex('users_firebase_uid_uq').on(t.firebaseUid),
    emailLowerUq: uniqueIndex('users_email_lower_uq')
      .on(sql`lower(${t.email})`)
      .where(sql`${t.email} IS NOT NULL AND ${t.deletedAt} IS NULL`),
  }),
);

export type UserRow = typeof users.$inferSelect;
