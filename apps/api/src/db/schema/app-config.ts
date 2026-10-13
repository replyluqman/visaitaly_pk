import { pgTable, text, jsonb, uuid, timestamp } from 'drizzle-orm/pg-core';

/** Every tunable value (PRD §6 zero-hardcoding). Written by CMS, read by API. */
export const appConfig = pgTable('app_config', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  description: text('description'),
  updatedBy: uuid('updated_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Shape of app_config['auth'].value */
export interface AuthConfigValue {
  max_active_devices: number;
}
