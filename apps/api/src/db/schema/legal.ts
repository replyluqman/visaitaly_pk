import { pgTable, uuid, text, boolean, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users.js';

/** Versioned legal text (PRD §18). Managed from Screens §44. */
export const legalVersions = pgTable(
  'legal_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** disclaimer | terms | privacy */
    docType: text('doc_type').notNull(),
    locale: text('locale').notNull().default('en'),
    version: text('version').notNull(),
    title: text('title').notNull(),
    bodyMd: text('body_md').notNull(),
    isMandatory: boolean('is_mandatory').notNull().default(true),
    isCurrent: boolean('is_current').notNull().default(false),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    publishedBy: uuid('published_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    docLocaleVersionUq: uniqueIndex('legal_versions_doc_locale_version_uq').on(
      t.docType,
      t.locale,
      t.version,
    ),
    currentUq: uniqueIndex('legal_versions_current_uq')
      .on(t.docType, t.locale)
      .where(sql`${t.isCurrent}`),
  }),
);

/**
 * The audit record proving which version a user accepted.
 * legal_version_id is ON DELETE RESTRICT — an accepted version must never
 * become deletable (PRD §18 legal defence).
 */
export const legalAcceptances = pgTable(
  'legal_acceptances',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    legalVersionId: uuid('legal_version_id')
      .notNull()
      .references(() => legalVersions.id, { onDelete: 'restrict' }),
    deviceId: uuid('device_id'),
    appVersion: text('app_version'),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userVersionUq: uniqueIndex('legal_acceptances_user_version_uq').on(t.userId, t.legalVersionId),
    userIdx: index('legal_acceptances_user_idx').on(t.userId),
  }),
);

export type LegalVersionRow = typeof legalVersions.$inferSelect;
export type LegalAcceptanceRow = typeof legalAcceptances.$inferSelect;
