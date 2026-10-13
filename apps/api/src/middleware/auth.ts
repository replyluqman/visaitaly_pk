import { sql } from 'drizzle-orm';
import { createMiddleware } from 'hono/factory';
import { DeviceStatus } from '@visaitaly/shared';
import type { AppEnv } from '../env.js';
import { AppError } from '../lib/errors.js';
import { verifyFirebaseIdToken } from '../lib/firebase.js';

/**
 * Verifies the Firebase ID token and nothing else.
 *
 * Only for POST /v1/auth/session, which runs *before* a device row exists and
 * therefore cannot require one. Every other route uses requireSession.
 */
export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  const token = await verifyFirebaseIdToken(c.req.header('Authorization'), c.env);
  c.set('auth', token);
  await next();
});

interface SessionRow extends Record<string, unknown> {
  user_id: string;
  user_status: string;
  device_status: string | null;
}

/**
 * Full session check for every authenticated route.
 *
 * Token → account → device, in one round trip. The device half is what makes
 * the 2-device rule (PRD §2) actually enforceable: eviction is app-level, so a
 * dropped device keeps a perfectly valid Firebase token and must be rejected
 * here or not at all.
 *
 * Device status maps to a distinct terminal error code because the Flutter
 * client shows different copy for each — "signed out by device limit" and
 * "signed out from your other device" are not the same message to a user who is
 * wondering whether they have been hacked.
 */
export const requireSession = createMiddleware<AppEnv>(async (c, next) => {
  const token = await verifyFirebaseIdToken(c.req.header('Authorization'), c.env);
  c.set('auth', token);

  const deviceId = c.req.header('X-Device-Id')?.trim();
  if (!deviceId) throw AppError.deviceHeaderMissing();

  // Reject a malformed id before it reaches ::uuid, which would 500 instead of 400.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(deviceId)) {
    throw AppError.validation({ 'X-Device-Id': ['Must be a UUID.'] });
  }

  const result = await c.get('db').execute<SessionRow>(sql`
    SELECT u.id     AS user_id,
           u.status AS user_status,
           d.status AS device_status
      FROM users u
      LEFT JOIN devices d
        ON d.user_id = u.id AND d.device_id = ${deviceId}::uuid
     WHERE u.firebase_uid = ${token.uid}
  `);

  const row = result.rows[0];
  // No account for a valid token: the row was deleted between issue and use.
  if (!row) throw AppError.unauthenticated('Account not found. Please sign in again.');
  if (row.user_status === 'deleted') throw AppError.userDeleted();

  switch (row.device_status) {
    case DeviceStatus.ACTIVE:
      break;
    case DeviceStatus.EVICTED:
      throw AppError.deviceEvicted();
    case DeviceStatus.SIGNED_OUT:
      throw AppError.deviceSignedOut();
    default:
      // null — never registered, or registered to a different account.
      throw AppError.deviceUnknown();
  }

  c.set('session', { userId: row.user_id, deviceId });
  await next();
});
