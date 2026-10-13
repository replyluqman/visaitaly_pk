import { sql } from 'drizzle-orm';
import type {
  Entitlement,
  MeResponse,
  OnboardingState,
  RegisterSessionInput,
} from '@visaitaly/shared';
import type { Db } from '../../db/client.js';
import type { VerifiedToken } from '../../lib/firebase.js';

const DEFAULT_MAX_ACTIVE_DEVICES = 2; // fallback only if app_config row is missing

type UserRowLite = {
  id: string;
  email: string | null;
  display_name: string | null;
  onboarding_state: OnboardingState;
  created_at: string;
  is_new: boolean;
}

/**
 * Idempotent upsert keyed on firebase_uid. Called on every login, so it must
 * never reset onboarding_state or clobber a display name the user has set.
 * `xmax = 0` is the standard Postgres trick for "this row was inserted, not updated".
 */
async function upsertUser(db: Db, token: VerifiedToken): Promise<UserRowLite> {
  const result = await db.execute<UserRowLite>(sql`
    INSERT INTO users (firebase_uid, email, display_name, last_login_at)
    VALUES (${token.uid}, ${token.email}, ${token.displayName}, now())
    ON CONFLICT (firebase_uid) DO UPDATE
      SET email         = COALESCE(EXCLUDED.email, users.email),
          display_name  = COALESCE(users.display_name, EXCLUDED.display_name),
          last_login_at = now()
    RETURNING id, email, display_name, onboarding_state, created_at,
              (xmax = 0) AS is_new
  `);
  const row = result.rows[0];
  if (!row) throw new Error('User upsert returned no row');
  return row;
}

/** PRD §6: read the limit from app_config, never a constant in code. */
async function maxActiveDevices(db: Db): Promise<number> {
  const result = await db.execute<{ max_active_devices: number | null }>(sql`
    SELECT (value->>'max_active_devices')::int AS max_active_devices
      FROM app_config WHERE key = 'auth'
  `);
  return result.rows[0]?.max_active_devices ?? DEFAULT_MAX_ACTIVE_DEVICES;
}

async function upsertDevice(db: Db, userId: string, input: RegisterSessionInput): Promise<void> {
  await db.execute(sql`
    INSERT INTO devices (user_id, device_id, platform, app_version, os_version, model, fcm_token,
                         status, last_login_at, last_seen_at)
    VALUES (${userId}, ${input.deviceId}::uuid, ${input.platform}, ${input.appVersion},
            ${input.osVersion ?? null}, ${input.model ?? null}, ${input.fcmToken ?? null},
            'active', now(), now())
    ON CONFLICT (user_id, device_id) DO UPDATE
      SET status        = 'active',
          evicted_at    = NULL,
          platform      = EXCLUDED.platform,
          app_version   = EXCLUDED.app_version,
          os_version    = EXCLUDED.os_version,
          model         = EXCLUDED.model,
          fcm_token     = COALESCE(EXCLUDED.fcm_token, devices.fcm_token),
          last_login_at = now(),
          last_seen_at  = now()
  `);
}

/**
 * PRD §2: keep the N most recently used active devices, evict the rest.
 * Runs as a separate statement, not a CTE: data-modifying CTEs share one
 * snapshot, so a `keep` CTE would not see the device just inserted above.
 * Both statements run inside the caller's transaction.
 */
async function evictOverflowDevices(db: Db, userId: string, keep: number): Promise<string[]> {
  const result = await db.execute<{ device_id: string }>(sql`
    UPDATE devices
       SET status = 'evicted', evicted_at = now()
     WHERE user_id = ${userId}
       AND status = 'active'
       AND id NOT IN (
         SELECT id FROM devices
          WHERE user_id = ${userId} AND status = 'active'
          ORDER BY last_login_at DESC, id DESC
          LIMIT ${keep}
       )
    RETURNING device_id
  `);
  return result.rows.map((r) => r.device_id);
}

/**
 * PRD §5: entitlement is resolved from Neon on every launch, never from
 * Firebase custom claims.
 *
 * STUB — returns empty until the applicants + orders modules land. The shape is
 * final; only the query body changes. Do not read entitlement anywhere else.
 */
async function resolveEntitlement(_db: Db, _userId: string): Promise<Entitlement> {
  return { premiumApplicantIds: [], hasAnyPremium: false };
}

async function countActiveDevices(db: Db, userId: string): Promise<number> {
  const result = await db.execute<{ count: number }>(sql`
    SELECT count(*)::int AS count FROM devices
     WHERE user_id = ${userId} AND status = 'active'
  `);
  return result.rows[0]?.count ?? 0;
}

function toMeResponse(
  user: UserRowLite,
  entitlement: Entitlement,
  maxActive: number,
  activeCount: number,
): MeResponse {
  return {
    user: {
      id: user.id,
      email: user.email,
      displayName: user.display_name,
      onboardingState: user.onboarding_state,
      createdAt: new Date(user.created_at).toISOString(),
    },
    entitlement,
    devices: { maxActive, activeCount },
  };
}

/**
 * Login. One transaction: upsert account → register device → evict overflow.
 * Either the whole session is established or none of it is — no half-registered
 * device that would lock the user out on the next request.
 */
export async function registerSession(db: Db, token: VerifiedToken, input: RegisterSessionInput) {
  return db.transaction(async (tx) => {
    const user = await upsertUser(tx, token);
    const keep = await maxActiveDevices(tx);
    await upsertDevice(tx, user.id, input);
    const evictedDeviceIds = await evictOverflowDevices(tx, user.id, keep);
    const activeCount = await countActiveDevices(tx, user.id);
    const entitlement = await resolveEntitlement(tx, user.id);

    return {
      ...toMeResponse(user, entitlement, keep, activeCount),
      session: { evictedDeviceIds, isNewUser: user.is_new },
    };
  });
}

/** GET /v1/me — called on every app launch (Screen 1 Splash). */
export async function getMe(db: Db, userId: string, deviceId: string): Promise<MeResponse> {
  // Single write per launch keeps the Account screen's "last seen" honest
  // without putting a write on every request.
  const result = await db.execute<UserRowLite & { max_active_devices: number | null; active_count: number }>(sql`
    WITH touched AS (
      UPDATE devices SET last_seen_at = now()
       WHERE user_id = ${userId} AND device_id = ${deviceId}::uuid
      RETURNING 1
    ),
    cfg AS (
      SELECT (value->>'max_active_devices')::int AS max_active_devices
        FROM app_config WHERE key = 'auth'
    )
    SELECT u.id, u.email, u.display_name, u.onboarding_state, u.created_at,
           false AS is_new,
           (SELECT max_active_devices FROM cfg) AS max_active_devices,
           (SELECT count(*)::int FROM devices d
             WHERE d.user_id = u.id AND d.status = 'active') AS active_count
      FROM users u
     WHERE u.id = ${userId}
  `);

  const row = result.rows[0];
  if (!row) throw new Error(`getMe: user ${userId} vanished mid-request`);

  const entitlement = await resolveEntitlement(db, userId);
  return toMeResponse(
    row,
    entitlement,
    row.max_active_devices ?? DEFAULT_MAX_ACTIVE_DEVICES,
    row.active_count,
  );
}
