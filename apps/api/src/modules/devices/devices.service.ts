import { sql } from 'drizzle-orm';
import type { DeviceSummary, DevicePlatform } from '@visaitaly/shared';
import type { Db } from '../../db/client.js';
import { AppError } from '../../lib/errors.js';

type DeviceListRow = {
  device_id: string;
  platform: DevicePlatform;
  model: string | null;
  app_version: string | null;
  last_login_at: string;
  last_seen_at: string;
}

/** Account/Settings screen (Screens §29) — active sessions list. */
export async function listActiveDevices(
  db: Db,
  userId: string,
  currentDeviceId: string,
): Promise<DeviceSummary[]> {
  const result = await db.execute<DeviceListRow>(sql`
    SELECT device_id, platform, model, app_version, last_login_at, last_seen_at
      FROM devices
     WHERE user_id = ${userId} AND status = 'active'
     ORDER BY last_login_at DESC
  `);

  return result.rows.map((r) => ({
    deviceId: r.device_id,
    platform: r.platform,
    model: r.model,
    appVersion: r.app_version,
    lastLoginAt: new Date(r.last_login_at).toISOString(),
    lastSeenAt: new Date(r.last_seen_at).toISOString(),
    isCurrent: r.device_id === currentDeviceId,
  }));
}

/**
 * Remote sign-out. Distinct from 'evicted' so the other device can show the
 * right message: "signed out by you" vs "device limit reached".
 * Signing out the current device is allowed — it is just a logout.
 */
export async function signOutDevice(
  db: Db,
  userId: string,
  targetDeviceId: string,
): Promise<void> {
  const result = await db.execute(sql`
    UPDATE devices
       SET status = 'signed_out', evicted_at = now()
     WHERE user_id = ${userId}
       AND device_id = ${targetDeviceId}::uuid
       AND status = 'active'
    RETURNING device_id
  `);
  if (result.rows.length === 0) {
    throw AppError.notFound('No active session found for that device.');
  }
}
