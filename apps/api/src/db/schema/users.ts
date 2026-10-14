import { pgTable, uuid, text, smallint, boolean, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    firebaseUid: text('firebase_uid').notNull(),
    email: text('email'),
    displayName: text('display_name'),
    /** disclaimer_pending | applicants_pending | stage_pending | complete */
    onboardingState: text('onboarding_state').notNull().default('disclaimer_pending'),
    /**
     * Screen 5 answer — declared intent, NOT a row count. The real count is
     * always count(applicants). Kept because it drives the onboarding loop and
     * lets an abandoned signup resume at the right applicant.
     */
    declaredApplicantCount: smallint('declared_applicant_count'),
    /** Which issuer vouches for this account: 'firebase' | 'native' (ADR 0013). */
    authProvider: text('auth_provider').notNull().default('firebase'),
    /** Whether that issuer verified the email; rewritten from the token at each login. */
    emailVerified: boolean('email_verified').notNull().default(false),
    /** active | deleted (GDPR soft delete — rows retained, PII cleared) */
    status: text('status').notNull().default('active'),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    firebaseUidUq: uniqueIndex('users_firebase_uid_uq').on(t.firebaseUid),
  }),
);

export type UserRow = typeof users.$inferSelect;
