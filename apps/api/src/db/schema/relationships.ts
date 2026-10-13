import { pgTable, text, jsonb, boolean, integer, timestamp, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * Relation to the sponsor (wife, son, father…) mapped onto one of the three
 * locked requirement categories (PRD §2). Content, not code: adding a relation
 * must not need an app release, so it is a CMS-editable table.
 */
export const relationships = pgTable(
  'relationships',
  {
    code: text('code').primaryKey(),
    /** { "en": "Wife" } — 'ur' key added when PRD §11a unblocks. */
    labels: jsonb('labels').$type<Record<string, string>>().notNull(),
    /** spouse | child | parent */
    category: text('category').notNull(),
    requiresDob: boolean('requires_dob').notNull().default(false),
    sortOrder: integer('sort_order').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    activeIdx: index('relationships_active_idx')
      .on(t.sortOrder)
      .where(sql`${t.isActive}`),
  }),
);

export type RelationshipRow = typeof relationships.$inferSelect;
