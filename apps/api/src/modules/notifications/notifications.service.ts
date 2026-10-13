import { sql, type SQL } from 'drizzle-orm';
import type {
  Notification,
  NotificationList,
  NotificationListQuery,
  NotificationPreferences,
  NotificationPreferencesInput,
  NotificationTab,
  UnreadCount,
} from '@visaitaly/shared';
import type { Db } from '../../db/client.js';
import { AppError } from '../../lib/errors.js';
import { decodeTsCursor, encodeTsCursor } from '../../lib/cursor.js';
import {
  NOTIFICATIONS_CONFIG_FALLBACK,
  REMINDERS_CONFIG_FALLBACK,
  readConfig,
} from '../../lib/app-config.js';
import type { PushSender } from '../../lib/fcm.js';
import { pgArray } from '../../lib/sql.js';
import notificationTypes from '../../lib/notification-types.json';

/** Locale notifications are rendered in until the user-language setting ships (PRD §11a: English-first). */
const RENDER_LOCALE = 'en';

export const NOTIFICATION_TYPES = Object.fromEntries(
  Object.entries(notificationTypes).filter(([k]) => !k.startsWith('_')),
) as Record<string, NotificationTab>;

/** Premium or grace — the audiences for reminders and requirement updates (PRD §8). */
const PREMIUM_OR_GRACE = (a: string): SQL => {
  const t = sql.raw(a);
  return sql`((${t}.premium_status = 'active' AND (${t}.access_until IS NULL OR ${t}.access_until > now()))
            OR (${t}.premium_status = 'expired_pending_confirmation' AND (${t}.grace_until IS NULL OR ${t}.grace_until > now())))`;
};

/** {placeholders} → values, in SQL (values come from admin-authored content and the DB, never from end users), so a set-based INSERT can render every row. Values are bound, never concatenated. */
const render = (template: SQL, vars: Record<string, SQL>): SQL => {
  const filled = Object.entries(vars).reduce<SQL>((acc, [k, v]) => sql`replace(${acc}, ${'{' + k + '}'}, ${v})`, template);
  // A placeholder the caller did not supply must never reach the user as raw "{braces}".
  return sql`regexp_replace(${filled}, '\{[A-Za-z]+\}', '', 'g')`;
};

async function hasTemplate(db: Db, type: string): Promise<boolean> {
  const r = await db.execute(sql`SELECT 1 FROM notification_templates WHERE type = ${type} AND locale = ${RENDER_LOCALE}`);
  return r.rows.length > 0;
}

// ---------------------------------------------------------------------------
// inbox (request path: one indexed read / one write each — PRD §14 rule 5)
// ---------------------------------------------------------------------------

type Row = {
  id: string; tab: NotificationTab; type: string; title: string; body: string; deep_link: string;
  applicant_id: string | null; created_at: string; created_at_raw: string; read_at: string | null;
};

export async function listNotifications(db: Db, userId: string, q: NotificationListQuery): Promise<NotificationList> {
  const after = q.cursor ? decodeTsCursor(q.cursor) : null;
  const r = await db.execute<Row>(sql`
    SELECT id, tab, type, title, body, deep_link, applicant_id, created_at, created_at::text AS created_at_raw, read_at
      FROM notifications
     WHERE user_id = ${userId} AND tab = ${q.tab}
       ${after ? sql`AND (created_at, id) < (${after[0]}::timestamptz, ${after[1]}::uuid)` : sql``}
     ORDER BY created_at DESC, id DESC
     LIMIT ${q.limit + 1}
  `);
  const page = r.rows.slice(0, q.limit);
  const last = page[page.length - 1];
  return {
    items: page.map(
      (n): Notification => ({
        id: n.id, tab: n.tab, type: n.type, title: n.title, body: n.body, deepLink: n.deep_link,
        applicantId: n.applicant_id, createdAt: new Date(n.created_at).toISOString(),
        readAt: n.read_at ? new Date(n.read_at).toISOString() : null,
      }),
    ),
    nextCursor: r.rows.length > q.limit && last ? encodeTsCursor(last.created_at_raw, last.id) : null,
  };
}

/** The bell badge: ONE indexed grouped count (notifications_unread_idx). */
export async function unreadCount(db: Db, userId: string): Promise<UnreadCount> {
  const r = await db.execute<{ tab: NotificationTab; n: number }>(sql`
    SELECT tab, count(*)::int AS n FROM notifications
     WHERE user_id = ${userId} AND read_at IS NULL GROUP BY tab
  `);
  const byTab = { reminder: 0, update: 0, activity: 0 };
  for (const row of r.rows) byTab[row.tab] = row.n;
  return { total: byTab.reminder + byTab.update + byTab.activity, byTab };
}

/** Mark-read is a single write. Idempotent: re-reading keeps the first read time. */
export async function markRead(db: Db, userId: string, id: string): Promise<void> {
  const r = await db.execute<{ id: string }>(sql`
    UPDATE notifications SET read_at = coalesce(read_at, now())
     WHERE id = ${id}::uuid AND user_id = ${userId} RETURNING id
  `);
  if (r.rows.length === 0) throw AppError.notFound('Notification not found.');
}

export async function markAllRead(db: Db, userId: string, tab?: NotificationTab): Promise<void> {
  await db.execute(sql`
    UPDATE notifications SET read_at = now()
     WHERE user_id = ${userId} AND read_at IS NULL ${tab ? sql`AND tab = ${tab}` : sql``}
  `);
}

export async function getPreferences(db: Db, userId: string): Promise<NotificationPreferences> {
  const r = await db.execute<{ tab: NotificationTab; enabled: boolean }>(sql`
    SELECT tab, enabled FROM notification_preferences WHERE user_id = ${userId} AND channel = 'push'
  `);
  const push = { reminder: true, update: true, activity: true };
  for (const row of r.rows) push[row.tab] = row.enabled;
  return { push };
}

export async function setPreferences(
  db: Db, userId: string, input: NotificationPreferencesInput,
): Promise<NotificationPreferences> {
  for (const [tab, enabled] of Object.entries(input.push)) {
    if (enabled === undefined) continue;
    await db.execute(sql`
      INSERT INTO notification_preferences (user_id, tab, channel, enabled)
      VALUES (${userId}, ${tab}, 'push', ${enabled})
      ON CONFLICT (user_id, tab, channel) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()
    `);
  }
  return getPreferences(db, userId);
}

// ---------------------------------------------------------------------------
// generic emit — for modules whose events produce a notification (Activity tab: orders, support, …)
// ---------------------------------------------------------------------------

export interface NotifyInput {
  userId: string;
  applicantId?: string | null;
  type: string;
  deepLink: string;
  dedupeKey: string;
  /** Substituted into the template: {title} {changeSummary} {days} {date}. */
  vars?: Record<string, string>;
  payload?: Record<string, unknown>;
}

/**
 * Persist one notification rendered from its template. Call with the SAME transaction handle as the
 * event that caused it (PRD §14 rule 4: event-triggered on an existing write). Returns false when the
 * dedupe key already exists. Throws if the type is unknown or has no template — a missing template is
 * a deploy problem (`preflight`), and silently dropping a notification would hide it.
 */
export async function notify(db: Db, n: NotifyInput): Promise<boolean> {
  const tab = NOTIFICATION_TYPES[n.type];
  if (!tab) throw new Error(`unknown notification type: ${n.type}`);
  const vars = n.vars ?? {};
  const r = await db.execute(sql`
    INSERT INTO notifications (user_id, applicant_id, tab, type, title, body, deep_link, payload, dedupe_key)
    SELECT ${n.userId}::uuid, ${n.applicantId ?? null}::uuid, ${tab}, ${n.type}, t.title,
           ${render(sql`t.body`, Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, sql`${v}::text`])))},
           ${n.deepLink}, ${JSON.stringify(n.payload ?? {})}::jsonb, ${n.dedupeKey}
      FROM notification_templates t WHERE t.type = ${n.type} AND t.locale = ${RENDER_LOCALE}
    ON CONFLICT (user_id, dedupe_key) DO NOTHING
  `);
  if (r.rowCount === 0 && !(await hasTemplate(db, n.type))) throw new Error(`no ${RENDER_LOCALE} template for ${n.type}`);
  return (r.rowCount ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Cron: Updates (admin publish → every affected premium applicant)
// ---------------------------------------------------------------------------

/**
 * Turns each not-yet-dispatched requirement version into one 'update' notification per affected
 * applicant (premium or grace, with an APPLICABLE item for it). The change summary is inline in the body
 * (PRD §14 rule 6). Idempotent: dedupe key `req:<version>:<applicant>`, and the dispatch row is written
 * in the same transaction. A version whose template is missing is skipped and retried next tick —
 * never marked dispatched and silently lost.
 */
export async function dispatchRequirementUpdates(
  db: Db, maxVersions = 5,
): Promise<{ versions: number; notifications: number; skippedNoTemplate: number }> {
  const pending = await db.execute<{ id: string; requirement_id: string; version: number }>(sql`
    SELECT rv.id, rv.requirement_id, rv.version
      FROM requirement_versions rv
      JOIN requirements r ON r.id = rv.requirement_id AND r.verification_status = 'published'
     WHERE NOT EXISTS (SELECT 1 FROM notification_dispatch d WHERE d.requirement_version_id = rv.id)
     ORDER BY rv.published_at, rv.id LIMIT ${maxVersions}
  `);
  let created = 0;
  let skipped = 0;
  for (const v of pending.rows) {
    const type = v.version === 1 ? 'requirement_added' : 'requirement_changed';
    if (!(await hasTemplate(db, type))) { skipped++; continue; }
    created += await db.transaction(async (tx) => {
      const ins = await tx.execute(sql`
        INSERT INTO notifications (user_id, applicant_id, tab, type, title, body, deep_link, payload, dedupe_key)
        SELECT ar.user_id, a.id, 'update', ${type}, t.title,
               ${render(sql`t.body`, {
                 title: sql`coalesce(r.title->>${RENDER_LOCALE}, r.code)`,
                 changeSummary: sql`coalesce(rv.change_summary->>${RENDER_LOCALE}, '')`,
               })},
               '/checklist/' || ar.id::text,
               jsonb_build_object('requirementCode', r.code, 'requirementVersion', rv.version),
               'req:' || rv.id::text || ':' || a.id::text
          FROM requirement_versions rv
          JOIN requirements r ON r.id = rv.requirement_id AND r.verification_status = 'published'
          JOIN notification_templates t ON t.type = ${type} AND t.locale = ${RENDER_LOCALE}
          JOIN applicant_requirements ar ON ar.requirement_id = r.id AND ar.is_applicable
          JOIN applicants a ON a.id = ar.applicant_id AND a.user_id = ar.user_id AND a.status = 'active'
         WHERE rv.id = ${v.id}::uuid AND ${PREMIUM_OR_GRACE('a')}
        ON CONFLICT (user_id, dedupe_key) DO NOTHING
      `);
      const n = ins.rowCount ?? 0;
      await tx.execute(sql`
        INSERT INTO notification_dispatch (requirement_version_id, notifications_created)
        VALUES (${v.id}::uuid, ${n}) ON CONFLICT DO NOTHING
      `);
      return n;
    });
  }
  return { versions: pending.rows.length - skipped, notifications: created, skippedNoTemplate: skipped };
}

// ---------------------------------------------------------------------------
// Cron: Reminders (from case data — never on a request path)
// ---------------------------------------------------------------------------

/**
 * Nulla Osta and document expiry, one reminder per threshold crossed (`reminders.days_before`,
 * default 30/7/1 days). The bucket is the smallest threshold ≥ days left (0 once expired), and it is
 * part of the dedupe key, so each threshold fires once however often the Cron runs.
 */
export async function generateReminders(db: Db): Promise<{ nullaOsta: number; documents: number }> {
  const cfg = await readConfig(db, 'reminders', REMINDERS_CONFIG_FALLBACK);
  const thresholds = [...cfg.days_before].sort((a, b) => a - b);
  const horizon = Math.max(...thresholds, 0);
  const bucket = (days: SQL): SQL =>
    sql`CASE WHEN ${days} < 0 THEN 0 ELSE (SELECT min(x) FROM unnest(${pgArray(thresholds, 'int')}) x WHERE x >= ${days}) END`;

  const nulla = await db.execute(sql`
    INSERT INTO notifications (user_id, applicant_id, tab, type, title, body, deep_link, payload, dedupe_key)
    SELECT a.user_id, a.id, 'reminder', 'nulla_osta_expiring', t.title,
           ${render(sql`t.body`, {
             days: sql`greatest(c.days_left, 0)::text`,
             date: sql`to_char(a.nulla_osta_expiry_date, 'YYYY-MM-DD')`,
           })},
           '/applicants/' || a.id::text,
           jsonb_build_object('daysLeft', c.days_left, 'expiryDate', to_char(a.nulla_osta_expiry_date, 'YYYY-MM-DD')),
           'nulla:' || a.id::text || ':' || to_char(a.nulla_osta_expiry_date, 'YYYY-MM-DD') || ':' || c.bkt::text
      FROM applicants a
      CROSS JOIN LATERAL (
        SELECT (a.nulla_osta_expiry_date - CURRENT_DATE) AS days_left,
               ${bucket(sql`(a.nulla_osta_expiry_date - CURRENT_DATE)`)} AS bkt
      ) c
      JOIN notification_templates t ON t.type = 'nulla_osta_expiring' AND t.locale = ${RENDER_LOCALE}
     WHERE a.status = 'active' AND a.nulla_osta_status = 'received'
       AND a.nulla_osta_expiry_date IS NOT NULL
       AND a.nulla_osta_expiry_date <= CURRENT_DATE + ${horizon}::int
       AND ${PREMIUM_OR_GRACE('a')}
       AND NOT EXISTS (
         SELECT 1 FROM notifications n WHERE n.user_id = a.user_id
            AND n.dedupe_key = 'nulla:' || a.id::text || ':' || to_char(a.nulla_osta_expiry_date, 'YYYY-MM-DD') || ':' || c.bkt::text)
     LIMIT ${cfg.batch_size}
    ON CONFLICT (user_id, dedupe_key) DO NOTHING
  `);

  const docs = await db.execute(sql`
    INSERT INTO notifications (user_id, applicant_id, tab, type, title, body, deep_link, payload, dedupe_key)
    SELECT d.user_id, d.applicant_id, 'reminder',
           CASE WHEN rq.id IS NULL THEN 'document_expiring_unlinked' ELSE 'document_expiring' END,
           t.title,
           ${render(sql`t.body`, {
             title: sql`coalesce(rq.title->>${RENDER_LOCALE}, '')`,
             days: sql`greatest(c.days_left, 0)::text`,
             date: sql`to_char(d.expiry_date, 'YYYY-MM-DD')`,
           })},
           CASE WHEN ar.id IS NULL THEN '/documents' ELSE '/checklist/' || ar.id::text END,
           jsonb_build_object('daysLeft', c.days_left, 'expiryDate', to_char(d.expiry_date, 'YYYY-MM-DD')),
           'doc:' || d.id::text || ':' || to_char(d.expiry_date, 'YYYY-MM-DD') || ':' || c.bkt::text
      FROM documents d
      JOIN applicants a ON a.id = d.applicant_id AND a.user_id = d.user_id AND a.status = 'active'
      LEFT JOIN applicant_requirements ar ON ar.id = d.applicant_requirement_id
      LEFT JOIN requirements rq ON rq.id = ar.requirement_id AND rq.verification_status = 'published'
      CROSS JOIN LATERAL (
        SELECT (d.expiry_date - CURRENT_DATE) AS days_left,
               ${bucket(sql`(d.expiry_date - CURRENT_DATE)`)} AS bkt
      ) c
      JOIN notification_templates t
        ON t.type = CASE WHEN rq.id IS NULL THEN 'document_expiring_unlinked' ELSE 'document_expiring' END
       AND t.locale = ${RENDER_LOCALE}
     WHERE d.status = 'active' AND d.expiry_date IS NOT NULL
       AND d.expiry_date <= CURRENT_DATE + ${horizon}::int
       AND ${PREMIUM_OR_GRACE('a')}
       AND NOT EXISTS (
         SELECT 1 FROM notifications n WHERE n.user_id = d.user_id
            AND n.dedupe_key = 'doc:' || d.id::text || ':' || to_char(d.expiry_date, 'YYYY-MM-DD') || ':' || c.bkt::text)
     LIMIT ${cfg.batch_size}
    ON CONFLICT (user_id, dedupe_key) DO NOTHING
  `);
  return { nullaOsta: nulla.rowCount ?? 0, documents: docs.rowCount ?? 0 };
}

// ---------------------------------------------------------------------------
// Cron: push fan-out (FCM is delivery only)
// ---------------------------------------------------------------------------

type Queued = {
  id: string; user_id: string; tab: NotificationTab; type: string; title: string; body: string;
  deep_link: string; push_attempts: number; push_enabled: boolean; tokens: string[];
};

/**
 * Sends queued notifications, at most `push_max_per_run` FCM calls per run (Workers free tier: 50
 * subrequests per invocation). The rest stay queued for the next tick. A notification leaves the queue when
 * it was delivered to ≥ 1 device, when push is off for its tab, or when the user has no registered device —
 * in the last two cases there is nothing to send and the inbox already has it. Dead tokens are cleared.
 */
export async function dispatchPush(
  db: Db, sender: PushSender | undefined,
): Promise<{ sent: number; skipped: number; failed: number; invalidTokens: number }> {
  const out = { sent: 0, skipped: 0, failed: 0, invalidTokens: 0 };
  if (!sender) return out;
  const cfg = await readConfig(db, 'notifications', NOTIFICATIONS_CONFIG_FALLBACK);

  const queue = await db.execute<Queued>(sql`
    SELECT n.id, n.user_id, n.tab, n.type, n.title, n.body, n.deep_link, n.push_attempts,
           coalesce((SELECT p.enabled FROM notification_preferences p
                      WHERE p.user_id = n.user_id AND p.tab = n.tab AND p.channel = 'push'), true) AS push_enabled,
           coalesce((SELECT array_agg(d.fcm_token) FROM devices d
                      WHERE d.user_id = n.user_id AND d.status = 'active' AND d.fcm_token IS NOT NULL), '{}') AS tokens
      FROM notifications n
     WHERE n.push_sent_at IS NULL AND n.push_attempts < ${cfg.push_max_attempts}
     ORDER BY n.created_at, n.id
     LIMIT ${cfg.push_max_per_run * 3}
  `);

  let budget = cfg.push_max_per_run;
  const done: string[] = [];
  const retry: string[] = [];
  const dead = new Set<string>();

  for (const n of queue.rows) {
    if (!n.push_enabled || n.tokens.length === 0) { done.push(n.id); out.skipped++; continue; }
    if (budget < n.tokens.length) break; // finish this notification next tick rather than split it
    let delivered = false;
    for (const token of n.tokens) {
      budget--;
      const r = await sender.send(token, {
        title: n.title, body: n.body, data: { notificationId: n.id, deepLink: n.deep_link, type: n.type },
      });
      if (r === 'ok') delivered = true;
      else if (r === 'invalid_token') dead.add(token);
    }
    if (delivered) { done.push(n.id); out.sent++; }
    else if (n.tokens.every((t) => dead.has(t))) { done.push(n.id); out.skipped++; } // nobody left to send to
    else { retry.push(n.id); out.failed++; }
  }

  if (done.length) await db.execute(sql`UPDATE notifications SET push_sent_at = now() WHERE id = ANY(${pgArray(done, 'uuid')})`);
  if (retry.length) await db.execute(sql`UPDATE notifications SET push_attempts = push_attempts + 1 WHERE id = ANY(${pgArray(retry, 'uuid')})`);
  if (dead.size) {
    const r = await db.execute(sql`UPDATE devices SET fcm_token = NULL WHERE fcm_token = ANY(${pgArray([...dead], 'text')})`);
    out.invalidTokens = r.rowCount ?? 0;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Cron: retention — READ rows older than N days; unread are kept
// ---------------------------------------------------------------------------

export async function purgeReadNotifications(db: Db): Promise<number> {
  const cfg = await readConfig(db, 'notifications', NOTIFICATIONS_CONFIG_FALLBACK);
  const r = await db.execute(sql`
    DELETE FROM notifications WHERE id IN (
      SELECT id FROM notifications
       WHERE read_at IS NOT NULL AND read_at < now() - make_interval(days => ${cfg.retention_days_read}::int)
       LIMIT ${cfg.retention_batch})
  `);
  return r.rowCount ?? 0;
}
