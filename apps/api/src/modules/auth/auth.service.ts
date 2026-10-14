import { sql } from 'drizzle-orm';
import type {
  Entitlement,
  LegalDocType,
  MeResponse,
  OnboardingState,
  RegisterSessionInput,
} from '@visaitaly/shared';
import type { Db } from '../../db/client.js';
import { AppError } from '../../lib/errors.js';
import type { VerifiedToken } from '../../lib/firebase.js';
import { APP_VERSION_CONFIG_FALLBACK, readConfig } from '../../lib/app-config.js';
import { isBelowMinimum } from '../../lib/version.js';

const DEFAULT_MAX_ACTIVE_DEVICES = 2; // fallback only if app_config row is missing

// `type`, not `interface`: Drizzle's db.execute<T extends Record<string, unknown>>
// rejects interfaces (no implicit index signature).
type UserRowLite = {
  id: string;
  email: string | null;
  display_name: string | null;
  onboarding_state: OnboardingState;
  created_at: string;
  is_new: boolean;
};

/**
 * Idempotent upsert keyed on firebase_uid. Called on every login, so it must
 * never reset onboarding_state or clobber a display name the user has set.
 * `xmax = 0` is the standard Postgres trick for "this row was inserted, not updated".
 */
async function upsertUser(db: Db, token: VerifiedToken): Promise<UserRowLite> {
  const result = await db.execute<UserRowLite>(sql`
    INSERT INTO users (firebase_uid, email, email_verified, display_name, last_login_at)
    VALUES (${token.uid}, ${token.email}, ${token.emailVerified}, ${token.displayName}, now())
    ON CONFLICT (firebase_uid) DO UPDATE
      SET email          = COALESCE(EXCLUDED.email, users.email),
          email_verified = EXCLUDED.email_verified,
          display_name  = COALESCE(users.display_name, EXCLUDED.display_name),
          last_login_at = now()
      WHERE users.status = 'active'
    RETURNING id, email, display_name, onboarding_state, created_at,
              (xmax = 0) AS is_new
  `);
  const row = result.rows[0];
  // ON CONFLICT ... WHERE filtered the row out: the account is deleted. Refuse
  // before any write so the PII wipe is never undone (SECURITY.md data lifecycle).
  if (!row) throw AppError.userDeleted();
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

type MeSnapshotRow = UserRowLite & {
  email_verified: boolean;
  min_app_version: string | null;
  declared_applicant_count: number | null;
  max_active_devices: number | null;
  active_device_count: number;
  premium_applicant_ids: string[] | null;
  grace_applicant_ids: string[] | null;
  applicant_total: number;
  applicant_awaiting_stage: number;
  pending_legal_doc_types: LegalDocType[] | null;
};

/**
 * The single source for every field of MeResponse, in ONE round trip.
 *
 * /v1/me runs on every app launch and is the CPU-sensitive endpoint (PRD §4,
 * 10 ms ceiling), so entitlement, legal state and applicant counts are folded
 * into one statement rather than four sequential queries against Hyperdrive.
 *
 * Pass touchDeviceId to record last_seen_at (one write per launch, PRD §4);
 * pass null from the login path, where upsertDevice has already set it.
 *
 * PRD §5: entitlement comes from Neon, never from Firebase custom claims.
 * Buckets are computed against now() rather than trusting premium_status alone,
 * because the daily Cron expiry sweep may not have run since a window closed.
 */
async function loadMeSnapshot(
  db: Db,
  userId: string,
  touchDeviceId: string | null,
): Promise<MeSnapshotRow> {
  const result = await db.execute<MeSnapshotRow>(sql`
    WITH touched AS (
      -- No-op when touchDeviceId is null: device_id = NULL never matches.
      UPDATE devices SET last_seen_at = now()
       WHERE user_id = ${userId} AND device_id = ${touchDeviceId}::uuid
      RETURNING 1
    ),
    cfg AS (
      SELECT (value->>'max_active_devices')::int AS max_active_devices
        FROM app_config WHERE key = 'auth'
    ),
    appcfg AS (
      SELECT value->>'min_app_version' AS min_app_version FROM app_config WHERE key = 'app'
    ),
    ent AS (
      SELECT COALESCE(array_agg(id) FILTER (WHERE bucket = 'premium'), '{}') AS premium_ids,
             COALESCE(array_agg(id) FILTER (WHERE bucket = 'grace'),   '{}') AS grace_ids
        FROM (
          SELECT id,
                 CASE
                   WHEN premium_status = 'active'
                        AND (access_until IS NULL OR access_until > now()) THEN 'premium'
                   WHEN premium_status = 'expired_pending_confirmation'
                        AND (grace_until IS NULL OR grace_until > now())   THEN 'grace'
                   ELSE 'expired'
                 END AS bucket
            FROM applicants
           WHERE user_id = ${userId} AND status = 'active' AND premium_status <> 'none'
        ) b
    ),
    appl AS (
      SELECT count(*)::int                                     AS total,
             count(*) FILTER (WHERE current_stage IS NULL)::int AS awaiting_stage
        FROM applicants
       WHERE user_id = ${userId} AND status = 'active'
    ),
    legal AS (
      SELECT COALESCE(array_agg(DISTINCT v.doc_type), '{}') AS pending_doc_types
        FROM legal_versions v
       WHERE v.is_current AND v.is_mandatory
         AND NOT EXISTS (
           SELECT 1
             FROM legal_acceptances a
             JOIN legal_versions av ON av.id = a.legal_version_id
            WHERE a.user_id = ${userId}
              AND av.doc_type = v.doc_type
              AND av.version  = v.version
         )
    )
    SELECT u.id, u.email, u.email_verified, u.display_name, u.onboarding_state, u.created_at,
           u.declared_applicant_count,
           (SELECT min_app_version FROM appcfg)   AS min_app_version,
           false AS is_new,
           (SELECT max_active_devices FROM cfg)   AS max_active_devices,
           (SELECT count(*)::int FROM devices d
             WHERE d.user_id = u.id AND d.status = 'active') AS active_device_count,
           (SELECT premium_ids FROM ent)          AS premium_applicant_ids,
           (SELECT grace_ids   FROM ent)          AS grace_applicant_ids,
           (SELECT total          FROM appl)      AS applicant_total,
           (SELECT awaiting_stage FROM appl)      AS applicant_awaiting_stage,
           (SELECT pending_doc_types FROM legal)  AS pending_legal_doc_types
      FROM users u
     WHERE u.id = ${userId}
  `);

  const row = result.rows[0];
  if (!row) throw new Error(`loadMeSnapshot: user ${userId} vanished mid-request`);
  return row;
}

function toMeResponse(row: MeSnapshotRow): MeResponse {
  const premiumApplicantIds = row.premium_applicant_ids ?? [];
  const graceApplicantIds = row.grace_applicant_ids ?? [];
  const pendingDocTypes = row.pending_legal_doc_types ?? [];

  const entitlement: Entitlement = {
    premiumApplicantIds,
    graceApplicantIds,
    hasAnyPremium: premiumApplicantIds.length > 0,
  };

  return {
    user: {
      id: row.id,
      email: row.email,
      displayName: row.display_name,
      onboardingState: row.onboarding_state,
      emailVerified: row.email_verified,
      createdAt: new Date(row.created_at).toISOString(),
    },
    app: { minAppVersion: row.min_app_version ?? APP_VERSION_CONFIG_FALLBACK.min_app_version },
    entitlement,
    devices: {
      maxActive: row.max_active_devices ?? DEFAULT_MAX_ACTIVE_DEVICES,
      activeCount: row.active_device_count,
    },
    legal: {
      requiresAcceptance: pendingDocTypes.length > 0,
      pendingDocTypes,
    },
    applicants: {
      declaredCount: row.declared_applicant_count,
      total: row.applicant_total,
      awaitingStage: row.applicant_awaiting_stage,
    },
  };
}

/**
 * Login. One transaction: upsert account → register device → evict overflow →
 * read back the snapshot. Either the whole session is established or none of it
 * is — no half-registered device that would lock the user out on the next request.
 */
export async function registerSession(db: Db, token: VerifiedToken, input: RegisterSessionInput) {
  // Version gate BEFORE any write: a build that is too old must not create or evict anything (ADR 0013).
  const { min_app_version } = await readConfig(db, 'app', APP_VERSION_CONFIG_FALLBACK);
  if (isBelowMinimum(input.appVersion, min_app_version)) throw AppError.appUpdateRequired(min_app_version);

  return db.transaction(async (tx) => {
    const user = await upsertUser(tx, token);
    const keep = await maxActiveDevices(tx);
    await upsertDevice(tx, user.id, input);
    const evictedDeviceIds = await evictOverflowDevices(tx, user.id, keep);

    // No device touch: upsertDevice already set last_seen_at.
    const snapshot = await loadMeSnapshot(tx, user.id, null);

    return {
      ...toMeResponse(snapshot),
      session: { evictedDeviceIds, isNewUser: user.is_new },
    };
  });
}

/** GET /v1/me — called on every app launch (Screen 1 Splash). */
export async function getMe(db: Db, userId: string, deviceId: string): Promise<MeResponse> {
  return toMeResponse(await loadMeSnapshot(db, userId, deviceId));
}
