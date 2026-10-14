import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import {
  SUPPORT_TOPICS,
  type AttachmentUploadInput,
  type SendSupportMessageInput,
  type SupportAttachmentUpload,
  type SupportMessage,
  type SupportMessageList,
  type SupportThreadView,
  type SupportTopic,
} from '@visaitaly/shared';
import type { Db } from '../../db/client.js';
import { AppError } from '../../lib/errors.js';
import { decodeTsCursor, encodeTsCursor } from '../../lib/cursor.js';
import { SLA_CONFIG_FALLBACK, SUPPORT_CONFIG_FALLBACK, readConfig } from '../../lib/app-config.js';
import { signDocumentUrl } from '../../lib/signed-url.js';
import type { ObjectStore } from '../../lib/storage.js';
import { addWorkingHours } from '../../lib/working-hours.js';
import { matchesMagic } from '../documents/documents.service.js';

const iso = (v: string | null) => (v ? new Date(v).toISOString() : null);
export const attachmentKey = (userId: string, id: string) => `support/${userId}/${id}`;

/** Paid ⇔ at least one applicant is premium or in grace (PRD §8, §14a: drives SLA length and topics). */
const TIER_SQL = (userId: string) => sql`
  EXISTS (SELECT 1 FROM applicants a WHERE a.user_id = ${userId} AND a.status = 'active'
            AND ((a.premium_status = 'active' AND (a.access_until IS NULL OR a.access_until > now()))
              OR (a.premium_status = 'expired_pending_confirmation' AND (a.grace_until IS NULL OR a.grace_until > now()))))
`;

async function currentTier(db: Db, userId: string): Promise<'free' | 'paid'> {
  const r = await db.execute<{ paid: boolean }>(sql`SELECT ${TIER_SQL(userId)} AS paid`);
  return r.rows[0]?.paid ? 'paid' : 'free';
}

export function allowedTopicsFor(tier: 'free' | 'paid', topicsFree: string[]): SupportTopic[] {
  return tier === 'paid' ? [...SUPPORT_TOPICS] : SUPPORT_TOPICS.filter((t) => topicsFree.includes(t));
}

/** Creates the user's single thread on first contact; safe under concurrent first messages. */
async function ensureThread(tx: Db, userId: string): Promise<{ id: string; status: string; sla_due_at: string | null }> {
  await tx.execute(sql`INSERT INTO support_threads (user_id) VALUES (${userId}) ON CONFLICT (user_id) DO NOTHING`);
  const r = await tx.execute<{ id: string; status: string; sla_due_at: string | null }>(sql`
    SELECT id, status, sla_due_at FROM support_threads WHERE user_id = ${userId} FOR UPDATE
  `);
  return r.rows[0]!;
}

// ---------------------------------------------------------------------------
// reads
// ---------------------------------------------------------------------------

export async function getThreadView(db: Db, userId: string, locale: string): Promise<SupportThreadView> {
  const [cfg, sla, tier, t] = await Promise.all([
    readConfig(db, 'support', SUPPORT_CONFIG_FALLBACK),
    readConfig(db, 'sla', SLA_CONFIG_FALLBACK),
    currentTier(db, userId),
    db.execute<{ id: string; status: SupportThreadView['status']; sla_due_at: string | null; unread: number }>(sql`
      SELECT t.id, t.status, t.sla_due_at,
             (SELECT count(*)::int FROM support_messages m WHERE m.thread_id = t.id
                AND m.sender_type = 'admin' AND m.read_by_user_at IS NULL) AS unread
        FROM support_threads t WHERE t.user_id = ${userId}
    `),
  ]);
  const row = t.rows[0];
  return {
    status: row?.status ?? 'none',
    tier,
    slaDueAt: row?.status === 'awaiting_support' ? iso(row.sla_due_at) : null,
    unreadCount: row?.unread ?? 0,
    workingHoursText: sla.working_hours_text?.[locale] ?? sla.working_hours_text?.en ?? null,
    allowedTopics: allowedTopicsFor(tier, cfg.topics_free),
  };
}

type MsgRow = {
  id: string; sender_type: SupportMessage['senderType']; body: string; topic: SupportTopic | null;
  applicant_id: string | null; created_at: string; created_at_raw: string; read_by_user_at: string | null;
  att_id: string | null; att_mime: string | null;
};

export const toMessage = (m: MsgRow): SupportMessage => ({
  id: m.id, senderType: m.sender_type, body: m.body, topic: m.topic, applicantId: m.applicant_id,
  attachment: m.att_id ? { id: m.att_id, mime: m.att_mime! } : null,
  createdAt: new Date(m.created_at).toISOString(), readByUserAt: iso(m.read_by_user_at),
});

export const MESSAGE_SELECT = sql`
  SELECT m.id, m.sender_type, m.body, m.topic, m.applicant_id, m.created_at, m.created_at::text AS created_at_raw,
         m.read_by_user_at, m.admin_id, m.canned_response_id,
         (SELECT a.id FROM support_attachments a WHERE a.message_id = m.id AND a.status = 'attached' LIMIT 1) AS att_id,
         (SELECT a.mime FROM support_attachments a WHERE a.message_id = m.id AND a.status = 'attached' LIMIT 1) AS att_mime
    FROM support_messages m
`;

export async function listMessages(
  db: Db, userId: string, q: { cursor?: string; limit: number },
): Promise<SupportMessageList> {
  const after = q.cursor ? decodeTsCursor(q.cursor) : null;
  const r = await db.execute<MsgRow>(sql`
    ${MESSAGE_SELECT}
    WHERE m.thread_id = (SELECT id FROM support_threads WHERE user_id = ${userId}) AND m.user_id = ${userId}
      ${after ? sql`AND (m.created_at, m.id) < (${after[0]}::timestamptz, ${after[1]}::uuid)` : sql``}
    ORDER BY m.created_at DESC, m.id DESC LIMIT ${q.limit + 1}
  `);
  const page = r.rows.slice(0, q.limit);
  const last = page[page.length - 1];
  return {
    items: page.map(toMessage),
    nextCursor: r.rows.length > q.limit && last ? encodeTsCursor(last.created_at_raw, last.id) : null,
  };
}

/** Opening the thread marks the admin replies as read (feeds the Activity badge). */
export async function markThreadRead(db: Db, userId: string): Promise<void> {
  await db.execute(sql`
    UPDATE support_messages SET read_by_user_at = now()
     WHERE user_id = ${userId} AND sender_type = 'admin' AND read_by_user_at IS NULL
  `);
}

// ---------------------------------------------------------------------------
// attachments: reserve → PUT (capability URL) → attach to a message
// ---------------------------------------------------------------------------

export async function reserveAttachment(
  db: Db, signingKey: string, origin: string, userId: string, input: AttachmentUploadInput,
): Promise<SupportAttachmentUpload> {
  const cfg = await readConfig(db, 'support', SUPPORT_CONFIG_FALLBACK);
  if (input.sizeBytes > cfg.attachment_max_bytes) throw AppError.uploadTooLarge(cfg.attachment_max_bytes);
  const id = randomUUID();
  await db.transaction(async (tx) => {
    const thread = await ensureThread(tx, userId);
    await tx.execute(sql`
      INSERT INTO support_attachments (id, user_id, thread_id, r2_key, mime, size_bytes)
      VALUES (${id}::uuid, ${userId}, ${thread.id}::uuid, ${attachmentKey(userId, id)}, ${input.mime}, ${input.sizeBytes})
    `);
  });
  const { exp, sig } = await signDocumentUrl(signingKey, 'PUT', id, cfg.attachment_upload_ttl_seconds);
  return {
    id, uploadUrl: `${origin}/v1/support/attachments/${id}/content?exp=${exp}&sig=${sig}`,
    expiresAt: new Date(exp * 1000).toISOString(), requiredHeaders: { 'Content-Type': input.mime },
  };
}

export async function loadAttachmentForUpload(db: Db, id: string) {
  const r = await db.execute<{ r2_key: string; mime: string; size_bytes: number }>(sql`
    SELECT r2_key, mime, size_bytes FROM support_attachments WHERE id = ${id}::uuid AND status = 'pending'
  `);
  return r.rows[0] ?? null;
}

export async function loadAttachmentForView(db: Db, id: string) {
  const r = await db.execute<{ r2_key: string; mime: string }>(sql`
    SELECT r2_key, mime FROM support_attachments WHERE id = ${id}::uuid AND status = 'attached'
  `);
  return r.rows[0] ?? null;
}

/** Signed GET for an attachment in the caller's own thread (404 for anyone else's). */
export async function attachmentViewUrl(
  db: Db, signingKey: string, origin: string, userId: string, id: string,
): Promise<{ url: string; expiresAt: string }> {
  const r = await db.execute(sql`SELECT 1 FROM support_attachments WHERE id = ${id}::uuid AND user_id = ${userId} AND status = 'attached'`);
  if (r.rows.length === 0) throw AppError.notFound('Attachment not found.');
  const cfg = await readConfig(db, 'support', SUPPORT_CONFIG_FALLBACK);
  const { exp, sig } = await signDocumentUrl(signingKey, 'GET', id, cfg.attachment_upload_ttl_seconds);
  return { url: `${origin}/v1/support/attachments/${id}/content?exp=${exp}&sig=${sig}`, expiresAt: new Date(exp * 1000).toISOString() };
}

// ---------------------------------------------------------------------------
// send
// ---------------------------------------------------------------------------

/**
 * A user message. One transaction: lock the user's thread, check the tier's topics and the hourly rate,
 * verify any attachment from storage (size + magic bytes — never the client's word), insert the message,
 * and move the thread to `awaiting_support` with an SLA deadline computed against the working-hours window.
 * A follow-up while already awaiting support does NOT push the deadline out (the clock started at the first
 * unanswered message). A reply to a closed thread reopens it.
 */
export async function sendMessage(
  db: Db, store: ObjectStore, userId: string, input: SendSupportMessageInput, now = new Date(),
): Promise<SupportMessage> {
  const [cfg, sla, tier] = await Promise.all([
    readConfig(db, 'support', SUPPORT_CONFIG_FALLBACK),
    readConfig(db, 'sla', SLA_CONFIG_FALLBACK),
    currentTier(db, userId),
  ]);
  if (!allowedTopicsFor(tier, cfg.topics_free).includes(input.topic)) throw AppError.supportTopicNotAllowed();

  // Verify the attachment's bytes BEFORE taking the thread lock (storage calls are slow).
  let attachment: { r2_key: string; id: string } | null = null;
  if (input.attachmentId) {
    const a = await db.execute<{ id: string; r2_key: string; mime: string; size_bytes: number }>(sql`
      SELECT id, r2_key, mime, size_bytes FROM support_attachments
       WHERE id = ${input.attachmentId}::uuid AND user_id = ${userId} AND status = 'pending'
    `);
    const row = a.rows[0];
    if (!row) throw AppError.notFound('Attachment not found.');
    const stat = await store.head(row.r2_key);
    const head = stat && stat.size === row.size_bytes ? await store.readHead(row.r2_key, 8) : null;
    if (!head || !matchesMagic(row.mime, head)) {
      await store.delete(row.r2_key);
      await db.execute(sql`UPDATE support_attachments SET status = 'deleted' WHERE id = ${row.id}::uuid`);
      throw AppError.uploadRejected();
    }
    attachment = { r2_key: row.r2_key, id: row.id };
  }

  if (input.applicantId) {
    const own = await db.execute(sql`SELECT 1 FROM applicants WHERE id = ${input.applicantId}::uuid AND user_id = ${userId} AND status = 'active'`);
    if (own.rows.length === 0) throw AppError.notFound('Applicant not found.');
  }

  const messageId = await db.transaction(async (tx) => {
    const thread = await ensureThread(tx, userId);
    const recent = await tx.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM support_messages
       WHERE user_id = ${userId} AND sender_type = 'user' AND created_at > now() - interval '1 hour'
    `);
    if ((recent.rows[0]?.n ?? 0) >= cfg.messages_per_hour) throw AppError.rateLimited();

    const ins = await tx.execute<{ id: string }>(sql`
      INSERT INTO support_messages (thread_id, user_id, sender_type, body, topic, applicant_id, read_by_user_at)
      VALUES (${thread.id}::uuid, ${userId}, 'user', ${input.body}, ${input.topic}, ${input.applicantId ?? null}::uuid, now())
      RETURNING id
    `);
    const id = ins.rows[0]!.id;
    if (attachment) {
      await tx.execute(sql`UPDATE support_attachments SET status = 'attached', message_id = ${id}::uuid WHERE id = ${attachment.id}::uuid`);
    }
    const hours = tier === 'paid' ? sla.support_paid_hours : sla.support_free_hours;
    const due = thread.status === 'awaiting_support' && thread.sla_due_at
      ? new Date(thread.sla_due_at)
      : addWorkingHours(now, hours, sla.working_hours_windows);
    await tx.execute(sql`
      UPDATE support_threads
         SET status = 'awaiting_support', tier = ${tier}, sla_due_at = ${due.toISOString()}::timestamptz,
             last_message_at = now(), last_user_message_at = now(), closed_at = NULL
       WHERE id = ${thread.id}::uuid
    `);
    return id;
  });

  const r = await db.execute<MsgRow>(sql`${MESSAGE_SELECT} WHERE m.id = ${messageId}::uuid`);
  return toMessage(r.rows[0]!);
}

// ---------------------------------------------------------------------------
// Cron: retention
// ---------------------------------------------------------------------------

/** Closed threads untouched for `retention_months` are deleted with their R2 attachments; abandoned uploads too. */
export async function purgeSupport(db: Db, store: ObjectStore): Promise<{ threads: number; attachments: number }> {
  const cfg = await readConfig(db, 'support', SUPPORT_CONFIG_FALLBACK);
  const old = await db.execute<{ id: string }>(sql`
    SELECT id FROM support_threads
     WHERE status = 'closed' AND last_message_at < now() - make_interval(months => ${cfg.retention_months}::int) LIMIT 20
  `);
  let attachments = 0;
  for (const t of old.rows) {
    const objs = await db.execute<{ id: string; r2_key: string }>(sql`SELECT id, r2_key FROM support_attachments WHERE thread_id = ${t.id}::uuid`);
    for (const o of objs.rows) { await store.delete(o.r2_key); attachments++; }
    await db.execute(sql`DELETE FROM support_threads WHERE id = ${t.id}::uuid`); // cascades messages + attachment rows
  }
  const abandoned = await db.execute<{ id: string; r2_key: string }>(sql`
    SELECT id, r2_key FROM support_attachments
     WHERE status <> 'attached' AND created_at < now() - make_interval(secs => ${cfg.attachment_upload_ttl_seconds * 2}::int) LIMIT 100
  `);
  for (const a of abandoned.rows) {
    await store.delete(a.r2_key);
    await db.execute(sql`DELETE FROM support_attachments WHERE id = ${a.id}::uuid`);
    attachments++;
  }
  return { threads: old.rows.length, attachments };
}
