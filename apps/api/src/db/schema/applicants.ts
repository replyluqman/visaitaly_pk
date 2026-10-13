import { pgTable, uuid, text, date, timestamp, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users.js';
import { relationships } from './relationships.js';

/**
 * One account → many independent applicants (PRD §2). Requirements never merge
 * across applicants, so every rule-engine input is per row.
 *
 * currentStage is nullable on purpose: NULL means Screen 7 has not run yet,
 * which is exactly what drives onboarding_state = 'stage_pending'. A DEFAULT
 * would make "not chosen" indistinguishable from "chose the first stage".
 */
export const applicants = pgTable(
  'applicants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    // profile (Screens §6) — minimum necessary only (PRD §19)
    displayName: text('display_name').notNull(),
    relationshipCode: text('relationship_code')
      .notNull()
      .references(() => relationships.code, { onDelete: 'restrict' }),
    /** Denormalised from relationships.category so the checklist query never joins. */
    relationshipCategory: text('relationship_category').notNull(),
    dateOfBirth: date('date_of_birth'),
    /** pakistan | italy | other */
    currentLocation: text('current_location').notNull(),

    // journey (PRD §12)
    /** One of the 8 canonical stages, or NULL until Screen 7 runs. */
    currentStage: text('current_stage'),
    stageUpdatedAt: timestamp('stage_updated_at', { withTimezone: true }),
    /** Set by the checklist engine (Module 3), never by Module 2. */
    caseGeneratedAt: timestamp('case_generated_at', { withTimezone: true }),

    // Nulla Osta tracker (PRD §14). The scan itself becomes a checklist
    // document in Module 3; these columns are the tracker, not the file.
    /** not_applicable | not_started | in_process | received */
    nullaOstaStatus: text('nulla_osta_status').notNull().default('not_started'),
    nullaOstaIssueDate: date('nulla_osta_issue_date'),
    nullaOstaExpiryDate: date('nulla_osta_expiry_date'),

    // premium lifecycle (PRD §7). Written by the orders + expiry modules,
    // read here for entitlement resolution.
    /** none | active | expired_pending_confirmation | expired */
    premiumStatus: text('premium_status').notNull().default('none'),
    accessUntil: timestamp('access_until', { withTimezone: true }),
    /** null | visa_granted | visa_granted_verified */
    visaStatus: text('visa_status'),
    visaGrantedSelfAt: timestamp('visa_granted_self_at', { withTimezone: true }),
    visaGrantedVerifiedAt: timestamp('visa_granted_verified_at', { withTimezone: true }),
    graceUntil: timestamp('grace_until', { withTimezone: true }),

    /** active | deleted (soft delete — PRD §7 retains data on expiry) */
    status: text('status').notNull().default('active'),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userActiveIdx: index('applicants_user_active_idx')
      .on(t.userId, t.createdAt)
      .where(sql`${t.status} = 'active'`),
    userPremiumIdx: index('applicants_user_premium_idx')
      .on(t.userId)
      .where(sql`${t.status} = 'active' AND ${t.premiumStatus} <> 'none'`),
    nullaOstaExpiryIdx: index('applicants_nulla_osta_expiry_idx')
      .on(t.nullaOstaExpiryDate)
      .where(sql`${t.status} = 'active' AND ${t.nullaOstaExpiryDate} IS NOT NULL`),
    accessUntilIdx: index('applicants_access_until_idx')
      .on(t.accessUntil)
      .where(sql`${t.status} = 'active' AND ${t.accessUntil} IS NOT NULL`),
  }),
);

/**
 * Append-only stage history. No screen requires it, but PRD §21 journey
 * completion is unmeasurable without it and it cannot be backfilled.
 */
export const applicantStageEvents = pgTable(
  'applicant_stage_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    applicantId: uuid('applicant_id')
      .notNull()
      .references(() => applicants.id, { onDelete: 'cascade' }),
    fromStage: text('from_stage'),
    toStage: text('to_stage').notNull(),
    /** user | admin | system */
    source: text('source').notNull().default('user'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    applicantIdx: index('applicant_stage_events_applicant_idx').on(t.applicantId, t.createdAt),
  }),
);

export type ApplicantRow = typeof applicants.$inferSelect;
export type ApplicantStageEventRow = typeof applicantStageEvents.$inferSelect;
