import { pgTable, uuid, text, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users.js';

export const devices = pgTable(
  'devices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Client-generated UUIDv4 from flutter_secure_storage. Never a hardware id. */
    deviceId: uuid('device_id').notNull(),
    /** android | ios */
    platform: text('platform').notNull(),
    appVersion: text('app_version'),
    osVersion: text('os_version'),
    model: text('model'),
    fcmToken: text('fcm_token'),
    /** active | evicted | signed_out */
    status: text('status').notNull().default('active'),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    evictedAt: timestamp('evicted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userDeviceUq: uniqueIndex('devices_user_device_uq').on(t.userId, t.deviceId),
    userActiveIdx: index('devices_user_active_idx')
      .on(t.userId, t.lastLoginAt.desc())
      .where(sql`${t.status} = 'active'`),
  }),
);

export type DeviceRow = typeof devices.$inferSelect;
