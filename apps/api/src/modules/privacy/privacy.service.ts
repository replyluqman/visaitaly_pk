import { sql } from 'drizzle-orm';
import type {
  ConsentsInput,
  Consents,
  DataExportStatus,
  DeletionAccepted,
} from '@visaitaly/shared';
import type { Db } from '../../db/client.js';
import { AppError } from '../../lib/errors.js';
import { PRIVACY_CONFIG_FALLBACK, readConfig } from '../../lib/app-config.js';
import type { IdentityDeleter } from '../../lib/identity.js';
import type { ObjectStore } from '../../lib/storage.js';
import { signDocumentUrl } from '../../lib/signed-url.js';
import { notify } from '../notifications/notifications.service.js';
import type { VerifiedToken } from '../../lib/firebase.js';

const iso = (v: string | null) => (v ? new Date(v).toISOString() : null);
export const exportKey = (userId: string, requestId: string) => `exports/${userId}/${requestId}.json`;

// ---------------------------------------------------------------------------
// consents (DATA-PRIVACY §2) — off until the user answers
// ---------------------------------------------------------------------------

export async function getConsents(db: Db, userId: string): Promise<Consents> {
  const r = await db.execute<{ purpose: string; granted: boolean; policy_version: string | null }>(sql`
    SELECT purpose, granted, policy_version FROM consents WHERE user_id = ${userId}
  `);
  const by = new Map(r.rows.map((x) => [x.purpose, x]));
  return {
    analytics: by.get('analytics')?.granted ?? false,
    crashReports: by.get('crash_reports')?.granted ?? false,
    marketingPush: by.get('marketing_push')?.granted ?? false,
    policyVersion: r.rows[0]?.policy_version ?? null,
    answered: r.rows.length > 0,
  };
}

export async function setConsents(db: Db, userId: string, input: ConsentsInput): Promise<Consents> {
  const pairs: Array<[string, boolean | undefined]> = [
    ['analytics', input.analytics], ['crash_reports', input.crashReports], ['marketing_push', input.marketingPush],
  ];
  await db.transaction(async (tx) => {
    for (const [purpose, granted] of pairs) {
      if (granted === undefined) continue;
      await tx.execute(sql`
        INSERT INTO consents (user_id, purpose, granted, policy_version) VALUES (${userId}, ${purpose}, ${granted}, ${input.policyVersion})
        ON CONFLICT (user_id, purpose) DO UPDATE SET granted = EXCLUDED.granted, policy_version = EXCLUDED.policy_version, updated_at = now()
      `);
    }
  });
  return getConsents(db, userId);
}

// ---------------------------------------------------------------------------
// right of access: request + status
// ---------------------------------------------------------------------------

export async function requestExport(db: Db, userId: string): Promise<{ requestId: string; status: 'received' }> {
  const cfg = await readConfig(db, 'privacy', PRIVACY_CONFIG_FALLBACK);
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT 1 FROM users WHERE id = ${userId} FOR UPDATE`); // serialise this user's requests
    const recent = await tx.execute<{ id: string; status: string }>(sql`
      SELECT id, status FROM data_requests
       WHERE user_id = ${userId} AND kind = 'export'
         AND (status IN ('received','processing')
              OR requested_at > now() - make_interval(hours => ${cfg.export_cooldown_hours}::int))
       ORDER BY requested_at DESC LIMIT 1
    `);
    if (recent.rows[0]) {
      throw recent.rows[0].status === 'received' || recent.rows[0].status === 'processing'
        ? AppError.conflict('An export is already being prepared.')
        : AppError.rateLimited('You can request one export per day.');
    }
    const r = await tx.execute<{ id: string }>(sql`
      INSERT INTO data_requests (user_id, kind) VALUES (${userId}, 'export') RETURNING id
    `);
    return { requestId: r.rows[0]!.id, status: 'received' as const };
  });
}

export async function getExport(
  db: Db, signingKey: string, origin: string, userId: string, id: string,
): Promise<DataExportStatus> {
  const cfg = await readConfig(db, 'privacy', PRIVACY_CONFIG_FALLBACK);
  const r = await db.execute<{
    id: string; status: DataExportStatus['status']; requested_at: string; completed_at: string | null;
    expires_at: string | null; r2_export_key: string | null;
  }>(sql`
    SELECT id, status, requested_at, completed_at, expires_at, r2_export_key FROM data_requests
     WHERE id = ${id}::uuid AND user_id = ${userId} AND kind = 'export'
  `);
  const row = r.rows[0];
  if (!row) throw AppError.notFound('Export not found.');
  const live = row.status === 'completed' && row.r2_export_key && row.expires_at && new Date(row.expires_at) > new Date();
  let downloadUrl: string | null = null;
  if (live) {
    const { exp, sig } = await signDocumentUrl(signingKey, 'GET', id, cfg.export_download_ttl_seconds);
    downloadUrl = `${origin}/v1/account/data-exports/${id}/content?exp=${exp}&sig=${sig}`;
  }
  return {
    id: row.id, status: row.status, requestedAt: new Date(row.requested_at).toISOString(),
    completedAt: iso(row.completed_at), expiresAt: iso(row.expires_at), downloadUrl,
  };
}

/** Capability-URL lookup: the object key of a ready, unexpired export. */
export async function loadExportForDownload(db: Db, id: string): Promise<string | null> {
  const r = await db.execute<{ r2_export_key: string }>(sql`
    SELECT r2_export_key FROM data_requests
     WHERE id = ${id}::uuid AND kind = 'export' AND status = 'completed'
       AND r2_export_key IS NOT NULL AND expires_at > now()
  `);
  return r.rows[0]?.r2_export_key ?? null;
}

// ---------------------------------------------------------------------------
// right to erasure: request (synchronous part)
// ---------------------------------------------------------------------------

/**
 * DELETE /v1/account — the synchronous half (DATA-PRIVACY §4). Needs a fresh sign-in: the Firebase
 * `auth_time` must be within `reauth_window_seconds`. One transaction marks the account deleted, signs
 * every device out and queues the request; every later call with the old token is USER_DELETED. The
 * data itself is erased by the Cron (`processErasures`) within minutes.
 */
export async function requestDeletion(
  db: Db, userId: string, token: VerifiedToken, nowMs = Date.now(),
): Promise<DeletionAccepted> {
  const cfg = await readConfig(db, 'privacy', PRIVACY_CONFIG_FALLBACK);
  if (nowMs / 1000 - token.authTime > cfg.reauth_window_seconds) throw AppError.reauthRequired();

  return db.transaction(async (tx) => {
    const u = await tx.execute<{ status: string }>(sql`SELECT status FROM users WHERE id = ${userId} FOR UPDATE`);
    if (!u.rows[0] || u.rows[0].status !== 'active') throw AppError.userDeleted();

    await tx.execute(sql`UPDATE users SET status = 'deleted', deleted_at = now() WHERE id = ${userId}`);
    await tx.execute(sql`
      UPDATE devices SET status = 'signed_out', evicted_at = now(), fcm_token = NULL
       WHERE user_id = ${userId} AND status = 'active'
    `);
    const r = await tx.execute<{ id: string }>(sql`
      INSERT INTO data_requests (user_id, kind, firebase_uid) VALUES (${userId}, 'delete', ${token.uid}) RETURNING id
    `);
    return { requestId: r.rows[0]!.id, status: 'received' as const };
  });
}

// ---------------------------------------------------------------------------
// Cron: build exports
// ---------------------------------------------------------------------------

/**
 * Builds the JSON export for each pending request (portable "right of access"). Contains every user-owned
 * row (never tokens, hashes or other people's data) plus a manifest of documents with their API paths —
 * the files themselves are fetched by the signed-in user. Stored privately in R2 and announced in the
 * Activity tab; deleted after `export_retention_days`.
 */
export async function processExports(
  db: Db, store: ObjectStore,
): Promise<{ built: number; expired: number }> {
  const cfg = await readConfig(db, 'privacy', PRIVACY_CONFIG_FALLBACK);
  const pending = await db.execute<{ id: string; user_id: string }>(sql`
    SELECT id, user_id FROM data_requests
     WHERE kind = 'export' AND status IN ('received','processing') AND attempts < ${cfg.max_attempts}
     ORDER BY requested_at LIMIT 3
  `);
  let built = 0;
  for (const req of pending.rows) {
    try {
      await db.execute(sql`UPDATE data_requests SET status = 'processing', started_at = coalesce(started_at, now()), attempts = attempts + 1 WHERE id = ${req.id}::uuid`);
      const body = await buildExport(db, req.user_id, cfg.export_row_cap);
      const key = exportKey(req.user_id, req.id);
      await store.put(key, new TextEncoder().encode(JSON.stringify(body, null, 2)), 'application/json');
      await db.transaction(async (tx) => {
        await tx.execute(sql`
          UPDATE data_requests SET status = 'completed', completed_at = now(), r2_export_key = ${key}, last_error = NULL,
                 expires_at = now() + make_interval(days => ${cfg.export_retention_days}::int)
           WHERE id = ${req.id}::uuid`);
        await notify(tx, {
          userId: req.user_id, type: 'data_export_ready', deepLink: `/account/exports/${req.id}`,
          dedupeKey: `export:${req.id}`, payload: { requestId: req.id },
        });
      });
      built++;
    } catch (err) {
      await db.execute(sql`
        UPDATE data_requests SET last_error = ${(err instanceof Error ? err.message : String(err)).slice(0, 200)},
               status = CASE WHEN attempts >= ${cfg.max_attempts} THEN 'failed' ELSE status END
         WHERE id = ${req.id}::uuid`);
    }
  }

  // Finished exports are deleted from R2 once they expire; the request row stays as the compliance record.
  const expired = await db.execute<{ id: string; r2_export_key: string }>(sql`
    SELECT id, r2_export_key FROM data_requests
     WHERE kind = 'export' AND r2_export_key IS NOT NULL AND expires_at < now() LIMIT 20
  `);
  for (const e of expired.rows) {
    await store.delete(e.r2_export_key);
    await db.execute(sql`UPDATE data_requests SET r2_export_key = NULL WHERE id = ${e.id}::uuid`);
  }
  return { built, expired: expired.rows.length };
}

async function buildExport(db: Db, userId: string, cap: number): Promise<Record<string, unknown>> {
  const rows = async (q: ReturnType<typeof sql>): Promise<{ rows: Record<string, unknown>[]; truncated: boolean }> => {
    const r = await db.execute<Record<string, unknown>>(q);
    return { rows: r.rows.slice(0, cap), truncated: r.rows.length > cap };
  };
  const [account, applicants, progress, documents, notifications, devices, acceptances, consents, prefs, support] = await Promise.all([
    db.execute(sql`SELECT email, display_name AS "displayName", onboarding_state AS "onboardingState", created_at AS "createdAt" FROM users WHERE id = ${userId}`),
    rows(sql`SELECT id, display_name AS "displayName", relationship_code AS "relationshipCode", to_char(date_of_birth,'YYYY-MM-DD') AS "dateOfBirth",
                    current_location AS "currentLocation", current_stage AS "currentStage", nulla_osta_status AS "nullaOstaStatus",
                    to_char(nulla_osta_issue_date,'YYYY-MM-DD') AS "nullaOstaIssueDate", to_char(nulla_osta_expiry_date,'YYYY-MM-DD') AS "nullaOstaExpiryDate",
                    premium_status AS "premiumStatus", created_at AS "createdAt"
               FROM applicants WHERE user_id = ${userId} AND status = 'active' ORDER BY created_at LIMIT ${cap + 1}`),
    rows(sql`SELECT ar.applicant_id AS "applicantId", r.code AS "requirementCode", ar.status, ar.is_applicable AS "isApplicable", ar.status_updated_at AS "statusUpdatedAt"
               FROM applicant_requirements ar JOIN requirements r ON r.id = ar.requirement_id
              WHERE ar.user_id = ${userId} ORDER BY ar.applicant_id, r.stage_order, r.sort_order LIMIT ${cap + 1}`),
    rows(sql`SELECT d.id, d.applicant_id AS "applicantId", d.applicant_requirement_id AS "checklistItemId", d.mime, d.size_bytes::bigint AS "sizeBytes",
                    to_char(d.expiry_date,'YYYY-MM-DD') AS "expiryDate", d.created_at AS "createdAt", '/v1/documents/' || d.id::text AS "apiPath"
               FROM documents d WHERE d.user_id = ${userId} AND d.status = 'active' ORDER BY d.created_at LIMIT ${cap + 1}`),
    rows(sql`SELECT tab, type, title, body, deep_link AS "deepLink", created_at AS "createdAt", read_at AS "readAt"
               FROM notifications WHERE user_id = ${userId} ORDER BY created_at DESC LIMIT ${cap + 1}`),
    rows(sql`SELECT platform, model, app_version AS "appVersion", status, last_login_at AS "lastLoginAt" FROM devices WHERE user_id = ${userId} ORDER BY last_login_at DESC LIMIT ${cap + 1}`),
    rows(sql`SELECT v.doc_type AS "docType", v.version, v.locale, a.accepted_at AS "acceptedAt"
               FROM legal_acceptances a JOIN legal_versions v ON v.id = a.legal_version_id WHERE a.user_id = ${userId} ORDER BY a.accepted_at LIMIT ${cap + 1}`),
    rows(sql`SELECT purpose, granted, policy_version AS "policyVersion", updated_at AS "updatedAt" FROM consents WHERE user_id = ${userId}`),
    rows(sql`SELECT tab, channel, enabled FROM notification_preferences WHERE user_id = ${userId}`),
    rows(sql`SELECT m.sender_type AS "sender", m.body, m.topic, m.created_at AS "createdAt",
                    EXISTS (SELECT 1 FROM support_attachments a WHERE a.message_id = m.id AND a.status = 'attached') AS "hasAttachment"
               FROM support_messages m WHERE m.user_id = ${userId} ORDER BY m.created_at LIMIT ${cap + 1}`),
  ]);
  return {
    exportedAt: new Date().toISOString(),
    note: 'Your data held by VisaItaly PK. Documents are listed with their API paths; download the files from the app.',
    account: account.rows[0] ?? null,
    applicants: applicants.rows, checklistProgress: progress.rows, documents: documents.rows,
    notifications: notifications.rows, devices: devices.rows, legalAcceptances: acceptances.rows,
    consents: consents.rows, notificationPreferences: prefs.rows, supportMessages: support.rows,
    truncated: [applicants, progress, documents, notifications, devices, acceptances, support].some((x) => x.truncated),
  };
}

// ---------------------------------------------------------------------------
// Cron: erasure (DATA-PRIVACY §4, asynchronous half)
// ---------------------------------------------------------------------------

/**
 * Erases a deleted account's data. Idempotent and resumable: every step tolerates already-done work, a
 * failure records `last_error` and the next tick continues, and the request only becomes 'completed' once
 * every step has finished. R2 objects go first (bounded per run — object calls are subrequests), THEN
 * their rows, so a crash never leaves an object without a row that points at it.
 *
 * Kept on purpose: the `users` tombstone (email/name/uid nulled — it anchors legal acceptances and, later,
 * orders), `legal_acceptances` (proof of consent), and — in later modules — financial records, pseudonymised.
 */
export async function processErasures(
  db: Db, store: ObjectStore, identity: IdentityDeleter | undefined,
): Promise<{ completed: number; inProgress: number; failed: number }> {
  const cfg = await readConfig(db, 'privacy', PRIVACY_CONFIG_FALLBACK);
  const pending = await db.execute<{ id: string; user_id: string; firebase_uid: string | null; identity_deleted_at: string | null }>(sql`
    SELECT id, user_id, firebase_uid, identity_deleted_at FROM data_requests
     WHERE kind = 'delete' AND status IN ('received','processing') ORDER BY requested_at LIMIT 3
  `);
  const out = { completed: 0, inProgress: 0, failed: 0 };

  for (const req of pending.rows) {
    try {
      await db.execute(sql`UPDATE data_requests SET status = 'processing', started_at = coalesce(started_at, now()), attempts = attempts + 1 WHERE id = ${req.id}::uuid`);

      // 1. objects first, then their rows — documents and any unexpired export files.
      let budget = cfg.delete_objects_per_run;
      const docs = await db.execute<{ id: string; r2_key: string }>(sql`
        SELECT id, r2_key FROM documents WHERE user_id = ${req.user_id} LIMIT ${budget}
      `);
      for (const d of docs.rows) {
        await store.delete(d.r2_key);
        await db.execute(sql`DELETE FROM documents WHERE id = ${d.id}::uuid`);
        budget--;
      }
      const exports = await db.execute<{ id: string; r2_export_key: string }>(sql`
        SELECT id, r2_export_key FROM data_requests WHERE user_id = ${req.user_id} AND r2_export_key IS NOT NULL LIMIT ${Math.max(budget, 0)}
      `);
      for (const e of exports.rows) {
        await store.delete(e.r2_export_key);
        await db.execute(sql`UPDATE data_requests SET r2_export_key = NULL WHERE id = ${e.id}::uuid`);
        budget--;
      }
      const att = await db.execute<{ id: string; r2_key: string }>(sql`
        SELECT id, r2_key FROM support_attachments WHERE user_id = ${req.user_id} LIMIT ${Math.max(budget, 0)}
      `);
      for (const a of att.rows) {
        await store.delete(a.r2_key);
        await db.execute(sql`DELETE FROM support_attachments WHERE id = ${a.id}::uuid`);
        budget--;
      }
      const moreDocs = await db.execute(sql`SELECT 1 FROM documents WHERE user_id = ${req.user_id} LIMIT 1`);
      const moreExports = await db.execute(sql`SELECT 1 FROM data_requests WHERE user_id = ${req.user_id} AND r2_export_key IS NOT NULL LIMIT 1`);
      const moreAtt = await db.execute(sql`SELECT 1 FROM support_attachments WHERE user_id = ${req.user_id} LIMIT 1`);
      if (moreDocs.rows.length > 0 || moreExports.rows.length > 0 || moreAtt.rows.length > 0) { out.inProgress++; continue; } // next tick

      // 2. database rows (cascades cover checklist progress, next actions, applicant notifications).
      await db.transaction(async (tx) => {
        await tx.execute(sql`DELETE FROM support_threads WHERE user_id = ${req.user_id}`); // messages cascade; attachments already gone
        await tx.execute(sql`DELETE FROM applicants WHERE user_id = ${req.user_id}`);
        await tx.execute(sql`DELETE FROM notifications WHERE user_id = ${req.user_id}`);
        await tx.execute(sql`DELETE FROM notification_preferences WHERE user_id = ${req.user_id}`);
        await tx.execute(sql`DELETE FROM consents WHERE user_id = ${req.user_id}`);
        await tx.execute(sql`DELETE FROM devices WHERE user_id = ${req.user_id}`);
        // 3. tombstone: nothing identifying remains; the row anchors legal acceptances.
        await tx.execute(sql`
          UPDATE users SET email = NULL, display_name = NULL, declared_applicant_count = NULL,
                 firebase_uid = 'deleted:' || id::text WHERE id = ${req.user_id}`);
      });

      // 4. the login at Firebase. Without a configured deleter this is recorded, not hidden.
      let identityDone = req.identity_deleted_at !== null || req.firebase_uid === null;
      if (!identityDone && identity) {
        const res = await identity.deleteUser(req.firebase_uid!);
        if (res === 'retry') throw new Error('identity deletion pending');
        identityDone = true;
      }
      await db.execute(sql`
        UPDATE data_requests SET status = 'completed', completed_at = now(), last_error = NULL,
               identity_deleted_at = CASE WHEN ${identityDone} THEN coalesce(identity_deleted_at, now()) ELSE identity_deleted_at END,
               firebase_uid = CASE WHEN ${identityDone} THEN NULL ELSE firebase_uid END
         WHERE id = ${req.id}::uuid`);
      out.completed++;
    } catch (err) {
      out.failed++;
      await db.execute(sql`
        UPDATE data_requests SET last_error = ${(err instanceof Error ? err.message : String(err)).slice(0, 200)},
               status = CASE WHEN attempts >= ${cfg.max_attempts} THEN 'failed' ELSE status END
         WHERE id = ${req.id}::uuid`);
    }
  }
  return out;
}
