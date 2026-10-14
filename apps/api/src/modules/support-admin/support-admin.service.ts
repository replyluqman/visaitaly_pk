import { sql, type SQL } from 'drizzle-orm';
import type {
  AdminReplyInput,
  AdminThreadDetail,
  AdminThreadSummary,
  CannedResponse,
  CreateCannedInput,
  Page,
  PatchCannedInput,
  SupportSummary,
  SupportThreadStatus,
  SupportTopic,
} from '@visaitaly/shared';
import type { Db } from '../../db/client.js';
import type { AdminContext } from '../../env.js';
import { AppError } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { decodeTsCursor, encodeTsCursor } from '../../lib/cursor.js';
import { SLA_CONFIG_FALLBACK, SUPPORT_CONFIG_FALLBACK, readConfig } from '../../lib/app-config.js';
import { signDocumentUrl } from '../../lib/signed-url.js';
import copyRules from '../../lib/copy-rules.json';
import { notify } from '../notifications/notifications.service.js';
import { MESSAGE_SELECT, toMessage } from '../support/support.service.js';

const iso = (v: string | null) => (v ? new Date(v).toISOString() : null);
const RENDER_LOCALE = 'en';

/** Verdict language is blocked at the tool, not left to operator discipline (PRD §10, §18 Risk 1). */
export function findForbiddenPhrase(text: string): string | null {
  const lower = text.toLowerCase();
  return copyRules.forbiddenPhrases.find((p) => lower.includes(p)) ?? null;
}

// ---------------------------------------------------------------------------
// inbox (Screen 35)
// ---------------------------------------------------------------------------

type ThreadRow = {
  id: string; user_id: string; status: SupportThreadStatus; tier: 'free' | 'paid'; sla_due_at: string | null;
  sla_raw: string | null; breached: boolean; assigned_admin_id: string | null; last_message_at: string | null;
  last_raw: string | null; preview: string | null;
};

const toThread = (t: ThreadRow): AdminThreadSummary => ({
  id: t.id, userId: t.user_id, status: t.status, tier: t.tier, slaDueAt: iso(t.sla_due_at), breached: t.breached,
  assignedAdminId: t.assigned_admin_id, lastMessageAt: iso(t.last_message_at), lastMessagePreview: t.preview,
});

const THREAD_SELECT = sql`
  SELECT t.id, t.user_id, t.status, t.tier, t.sla_due_at, t.sla_due_at::text AS sla_raw,
         (t.status = 'awaiting_support' AND t.sla_due_at < now()) AS breached,
         t.assigned_admin_id, t.last_message_at, t.last_message_at::text AS last_raw,
         (SELECT left(m.body, 120) FROM support_messages m WHERE m.thread_id = t.id AND m.sender_type = 'user'
           ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS preview
    FROM support_threads t
`;

/**
 * Awaiting-support threads sort by SLA deadline (most urgent first); every other state by recent activity.
 * Each mode has its own keyset, matching its index.
 */
export async function listThreads(
  db: Db, actor: AdminContext,
  q: { status: SupportThreadStatus; assignee?: 'me' | 'unassigned'; cursor?: string; limit: number },
): Promise<Page<AdminThreadSummary>> {
  const bySla = q.status === 'awaiting_support';
  const after = q.cursor ? decodeTsCursor(q.cursor) : null;
  const where: SQL[] = [sql`t.status = ${q.status}`];
  if (q.assignee === 'me') where.push(sql`t.assigned_admin_id = ${actor.id}::uuid`);
  if (q.assignee === 'unassigned') where.push(sql`t.assigned_admin_id IS NULL`);
  if (after) {
    where.push(bySla
      ? sql`(t.sla_due_at, t.id) > (${after[0]}::timestamptz, ${after[1]}::uuid)`
      : sql`(t.last_message_at, t.id) < (${after[0]}::timestamptz, ${after[1]}::uuid)`);
  }
  const r = await db.execute<ThreadRow>(sql`
    ${THREAD_SELECT} WHERE ${sql.join(where, sql` AND `)}
    ORDER BY ${bySla ? sql`t.sla_due_at, t.id` : sql`t.last_message_at DESC, t.id DESC`}
    LIMIT ${q.limit + 1}
  `);
  const page = r.rows.slice(0, q.limit);
  const last = page[page.length - 1];
  const cursorOf = (t: ThreadRow) => (bySla ? t.sla_raw : t.last_raw);
  return {
    items: page.map(toThread),
    nextCursor: r.rows.length > q.limit && last && cursorOf(last) ? encodeTsCursor(cursorOf(last)!, last.id) : null,
  };
}

export async function supportSummary(db: Db): Promise<SupportSummary> {
  const r = await db.execute<{ awaiting: number; breached: number; unassigned: number }>(sql`
    SELECT count(*)::int AS awaiting,
           count(*) FILTER (WHERE sla_due_at < now())::int AS breached,
           count(*) FILTER (WHERE assigned_admin_id IS NULL)::int AS unassigned
      FROM support_threads WHERE status = 'awaiting_support'
  `);
  const x = r.rows[0]!;
  return { awaitingSupport: x.awaiting, breached: x.breached, unassigned: x.unassigned };
}

export async function getThreadDetail(
  db: Db, id: string, q: { cursor?: string; limit: number },
): Promise<AdminThreadDetail> {
  const t = await db.execute<ThreadRow>(sql`${THREAD_SELECT} WHERE t.id = ${id}::uuid`);
  const thread = t.rows[0];
  if (!thread) throw AppError.notFound('Thread not found.');
  const after = q.cursor ? decodeTsCursor(q.cursor) : null;
  const [msgs, ctxUser, ctxApplicants] = await Promise.all([
    db.execute<Parameters<typeof toMessage>[0] & { admin_id: string | null; canned_response_id: string | null }>(sql`
      ${MESSAGE_SELECT}
      WHERE m.thread_id = ${id}::uuid
        ${after ? sql`AND (m.created_at, m.id) < (${after[0]}::timestamptz, ${after[1]}::uuid)` : sql``}
      ORDER BY m.created_at DESC, m.id DESC LIMIT ${q.limit + 1}
    `),
    db.execute<{ email: string | null }>(sql`SELECT email FROM users WHERE id = ${thread.user_id}::uuid`),
    db.execute<{ id: string; relationship_code: string; current_stage: string | null; premium_status: string }>(sql`
      SELECT id, relationship_code, current_stage, premium_status FROM applicants
       WHERE user_id = ${thread.user_id}::uuid AND status = 'active' ORDER BY created_at
    `),
  ]);
  const page = msgs.rows.slice(0, q.limit);
  const last = page[page.length - 1];
  return {
    thread: toThread(thread),
    context: {
      email: ctxUser.rows[0]?.email ?? null,
      applicants: ctxApplicants.rows.map((a) => ({ id: a.id, relationshipCode: a.relationship_code, currentStage: a.current_stage, premiumStatus: a.premium_status })),
    },
    messages: page.map((m) => ({ ...toMessage(m), adminId: m.admin_id, cannedResponseId: m.canned_response_id })),
    nextCursor: msgs.rows.length > q.limit && last ? encodeTsCursor(last.created_at_raw, last.id) : null,
  };
}

// ---------------------------------------------------------------------------
// canned responses → rendered at send time from real context
// ---------------------------------------------------------------------------

const PLACEHOLDER = /\{([a-z_]+)\}/g;
/** Placeholders a canned response may use today. Order-related ones arrive with Module 6. */
export const SUPPORTED_PLACEHOLDERS = [
  'requirement_title', 'requirement_deep_link', 'source_name', 'verified_days_ago', 'working_hours_text', 'how_we_verify_link',
] as const;

const placeholdersOf = (text: string): string[] => [...new Set([...text.matchAll(PLACEHOLDER)].map((m) => m[1]!))];

function validateCannedBody(body: Record<string, string>): void {
  const details: string[] = [];
  for (const [locale, text] of Object.entries(body)) {
    const bad = findForbiddenPhrase(text);
    if (bad) details.push(`${locale}: contains forbidden phrase "${bad}"`);
    const unknown = placeholdersOf(text).filter((p) => !(SUPPORTED_PLACEHOLDERS as readonly string[]).includes(p));
    if (unknown.length) details.push(`${locale}: unknown placeholder(s) ${unknown.map((u) => `{${u}}`).join(', ')}`);
  }
  if (details.length) throw AppError.validation({ body: details });
}

async function renderCanned(
  db: Db, canned: { body: Record<string, string>; requirement_id: string | null }, userId: string,
): Promise<string> {
  const template = canned.body[RENDER_LOCALE] ?? '';
  const need = placeholdersOf(template);
  const values: Record<string, string> = { how_we_verify_link: '/how-we-verify' };
  const missing: string[] = [];

  if (need.some((n) => ['requirement_title', 'requirement_deep_link', 'source_name', 'verified_days_ago'].includes(n))) {
    const r = canned.requirement_id
      ? await db.execute<{ title: string | null; source_name: string | null; days: number | null; item_id: string | null }>(sql`
          SELECT r.title->>${RENDER_LOCALE} AS title, s.name->>${RENDER_LOCALE} AS source_name,
                 CASE WHEN r.last_verified_at IS NULL THEN NULL ELSE (CURRENT_DATE - r.last_verified_at::date) END AS days,
                 (SELECT ar.id FROM applicant_requirements ar JOIN applicants a ON a.id = ar.applicant_id
                   WHERE ar.requirement_id = r.id AND ar.user_id = ${userId} AND ar.is_applicable AND a.status = 'active'
                   ORDER BY a.created_at LIMIT 1) AS item_id
            FROM requirements r LEFT JOIN sources s ON s.id = r.source_id
           WHERE r.id = ${canned.requirement_id}::uuid AND r.verification_status = 'published'
        `)
      : null;
    const row = r?.rows[0];
    if (row?.title) values.requirement_title = row.title; else missing.push('requirement_title');
    if (row?.item_id) values.requirement_deep_link = `/checklist/${row.item_id}`; else missing.push('requirement_deep_link');
    if (row?.source_name) values.source_name = row.source_name; else missing.push('source_name');
    if (row?.days !== null && row?.days !== undefined) values.verified_days_ago = String(row.days); else missing.push('verified_days_ago');
  }
  if (need.includes('working_hours_text')) {
    const sla = await readConfig(db, 'sla', SLA_CONFIG_FALLBACK);
    const t = sla.working_hours_text?.[RENDER_LOCALE];
    if (t) values.working_hours_text = t; else missing.push('working_hours_text');
  }
  const unresolved = need.filter((n) => !(n in values));
  if (unresolved.length || missing.length) {
    throw AppError.validation({
      cannedResponseId: [`Cannot fill: ${[...new Set([...missing, ...unresolved])].map((m) => `{${m}}`).join(', ')} — the context for this user/thread is missing.`],
    });
  }
  return template.replace(PLACEHOLDER, (_m, k: string) => values[k]!);
}

// ---------------------------------------------------------------------------
// reply
// ---------------------------------------------------------------------------

/**
 * An operator reply. Either a canned response (rendered from the thread's real context — this is how requirement
 * questions are answered) or free text for an in-scope topic that passes the verdict-language screen. The thread
 * moves to `awaiting_user` and the SLA clock stops; the author is recorded and the message audited (PRD §16);
 * the user gets an Activity notification. A failing notification is logged and does NOT lose the reply.
 */
export async function replyToThread(
  db: Db, actor: AdminContext, threadId: string, input: AdminReplyInput, requestId: string,
) {
  const th = await db.execute<{ user_id: string }>(sql`SELECT user_id FROM support_threads WHERE id = ${threadId}::uuid`);
  const userId = th.rows[0]?.user_id;
  if (!userId) throw AppError.notFound('Thread not found.');

  let body: string;
  let topic: SupportTopic | null = input.topic ?? null;
  let cannedId: string | null = null;
  let cannedCode: string | null = null;
  if (input.cannedResponseId) {
    const c = await db.execute<{ id: string; code: string; body: Record<string, string>; topic: SupportTopic | null; requirement_id: string | null; is_active: boolean }>(sql`
      SELECT id, code, body, topic, requirement_id, is_active FROM canned_responses WHERE id = ${input.cannedResponseId}::uuid
    `);
    const row = c.rows[0];
    if (!row) throw AppError.notFound('Canned response not found.');
    if (!row.is_active) throw AppError.conflict('That canned response is inactive.');
    body = await renderCanned(db, row, userId);
    topic = row.topic ?? topic;
    cannedId = row.id;
    cannedCode = row.code;
  } else {
    if (!input.topic) throw AppError.validation({ topic: ['A topic is required for a free-text reply.'] });
    const bad = findForbiddenPhrase(input.body!);
    if (bad) {
      throw AppError.validation({
        body: [`This reads as advice or a verdict ("${bad}"). Requirement and eligibility questions are answered with a canned requirement link.`],
      });
    }
    body = input.body!;
  }

  const messageId = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT 1 FROM support_threads WHERE id = ${threadId}::uuid FOR UPDATE`);
    const ins = await tx.execute<{ id: string }>(sql`
      INSERT INTO support_messages (thread_id, user_id, sender_type, admin_id, body, topic, canned_response_id, read_by_admin_at)
      VALUES (${threadId}::uuid, ${userId}, 'admin', ${actor.id}::uuid, ${body}, ${topic}, ${cannedId}::uuid, now())
      RETURNING id
    `);
    const id = ins.rows[0]!.id;
    await tx.execute(sql`
      UPDATE support_threads
         SET status = 'awaiting_user', sla_due_at = NULL, closed_at = NULL, last_message_at = now(),
             assigned_admin_id = coalesce(assigned_admin_id, ${actor.id}::uuid)
       WHERE id = ${threadId}::uuid
    `);
    await audit(tx, {
      actorType: 'admin', actorId: actor.id, action: 'support.reply', targetType: 'support_thread', targetId: threadId,
      metadata: { messageId: id, canned: cannedCode ?? false, topic }, requestId,
    });
    return id;
  });

  // After commit: a notification problem must never lose or roll back the reply.
  try {
    await notify(db, { userId, type: 'support_reply', deepLink: '/support', dedupeKey: `support:${messageId}`, payload: { threadId } });
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', job: 'support_reply_notify', message: err instanceof Error ? err.message : String(err) }));
  }
  const r = await db.execute<Parameters<typeof toMessage>[0]>(sql`${MESSAGE_SELECT} WHERE m.id = ${messageId}::uuid`);
  return toMessage(r.rows[0]!);
}

// ---------------------------------------------------------------------------
// assign / close / reopen
// ---------------------------------------------------------------------------

export async function assignThread(
  db: Db, actor: AdminContext, threadId: string, adminId: string | null, requestId: string,
): Promise<AdminThreadSummary> {
  await db.transaction(async (tx) => {
    const t = await tx.execute(sql`SELECT 1 FROM support_threads WHERE id = ${threadId}::uuid FOR UPDATE`);
    if (t.rows.length === 0) throw AppError.notFound('Thread not found.');
    if (adminId) {
      const a = await tx.execute(sql`
        SELECT 1 FROM admins a WHERE a.id = ${adminId}::uuid AND a.status = 'active'
           AND (a.is_super OR EXISTS (SELECT 1 FROM admin_permissions p WHERE p.admin_id = a.id AND p.scope = 'support_manage'))
      `);
      if (a.rows.length === 0) throw AppError.validation({ adminId: ['Not an active admin with support access.'] });
    }
    await tx.execute(sql`UPDATE support_threads SET assigned_admin_id = ${adminId}::uuid WHERE id = ${threadId}::uuid`);
    await audit(tx, {
      actorType: 'admin', actorId: actor.id, action: 'support.assign', targetType: 'support_thread', targetId: threadId,
      metadata: { assignedTo: adminId }, requestId,
    });
  });
  return (await getThreadDetail(db, threadId, { limit: 1 })).thread;
}

export async function setThreadState(
  db: Db, actor: AdminContext, threadId: string, action: 'close' | 'reopen', requestId: string,
): Promise<AdminThreadSummary> {
  await db.transaction(async (tx) => {
    const t = await tx.execute<{ status: SupportThreadStatus }>(sql`
      SELECT status FROM support_threads WHERE id = ${threadId}::uuid FOR UPDATE
    `);
    const row = t.rows[0];
    if (!row) throw AppError.notFound('Thread not found.');
    if (action === 'close') {
      if (row.status === 'closed') throw AppError.conflict('Already closed.');
      await tx.execute(sql`UPDATE support_threads SET status = 'closed', closed_at = now(), sla_due_at = NULL WHERE id = ${threadId}::uuid`);
    } else {
      if (row.status !== 'closed') throw AppError.conflict('Only a closed thread can be reopened.');
      // Reopened for the user: back to awaiting_user (the next user message restarts the SLA).
      await tx.execute(sql`UPDATE support_threads SET status = 'awaiting_user', closed_at = NULL, sla_due_at = NULL WHERE id = ${threadId}::uuid`);
    }
    await audit(tx, {
      actorType: 'admin', actorId: actor.id, action: `support.${action}`, targetType: 'support_thread', targetId: threadId,
      metadata: { from: row.status }, requestId,
    });
  });
  return (await getThreadDetail(db, threadId, { limit: 1 })).thread;
}

/** Signed GET for an attachment in any thread (support operator). Audited — it is a user's image. */
export async function adminAttachmentUrl(
  db: Db, actor: AdminContext, signingKey: string, origin: string, id: string, requestId: string,
): Promise<{ url: string; expiresAt: string }> {
  const a = await db.execute<{ thread_id: string }>(sql`SELECT thread_id FROM support_attachments WHERE id = ${id}::uuid AND status = 'attached'`);
  if (!a.rows[0]) throw AppError.notFound('Attachment not found.');
  const cfg = await readConfig(db, 'support', SUPPORT_CONFIG_FALLBACK);
  const { exp, sig } = await signDocumentUrl(signingKey, 'GET', id, cfg.attachment_upload_ttl_seconds);
  await audit(db, {
    actorType: 'admin', actorId: actor.id, action: 'support.view_attachment', targetType: 'support_thread',
    targetId: a.rows[0].thread_id, metadata: { attachmentId: id }, requestId,
  });
  return { url: `${origin}/v1/support/attachments/${id}/content?exp=${exp}&sig=${sig}`, expiresAt: new Date(exp * 1000).toISOString() };
}

// ---------------------------------------------------------------------------
// canned responses CRUD (CMS-managed: the boundary is enforced by tooling)
// ---------------------------------------------------------------------------

type CannedRow = { id: string; code: string; title: string; body: Record<string, string>; topic: SupportTopic | null; requirement_id: string | null; is_active: boolean; updated_at: string };
const toCanned = (c: CannedRow): CannedResponse => ({
  id: c.id, code: c.code, title: c.title, body: c.body, topic: c.topic, requirementId: c.requirement_id,
  isActive: c.is_active, updatedAt: new Date(c.updated_at).toISOString(),
});

export async function listCanned(db: Db, activeOnly: boolean): Promise<{ items: CannedResponse[] }> {
  const r = await db.execute<CannedRow>(sql`
    SELECT id, code, title, body, topic, requirement_id, is_active, updated_at FROM canned_responses
     ${activeOnly ? sql`WHERE is_active` : sql``} ORDER BY code
  `);
  return { items: r.rows.map(toCanned) };
}

async function assertRequirementExists(tx: Db, id: string | null | undefined) {
  if (!id) return;
  const r = await tx.execute(sql`SELECT 1 FROM requirements WHERE id = ${id}::uuid`);
  if (r.rows.length === 0) throw AppError.validation({ requirementId: ['No such requirement.'] });
}

export async function createCanned(db: Db, actor: AdminContext, input: CreateCannedInput, requestId: string): Promise<CannedResponse> {
  validateCannedBody(input.body);
  const id = await db.transaction(async (tx) => {
    const dup = await tx.execute(sql`SELECT 1 FROM canned_responses WHERE code = ${input.code}`);
    if (dup.rows.length > 0) throw AppError.conflict('A canned response with that code already exists.');
    await assertRequirementExists(tx, input.requirementId);
    const r = await tx.execute<{ id: string }>(sql`
      INSERT INTO canned_responses (code, title, body, topic, requirement_id, updated_by)
      VALUES (${input.code}, ${input.title}, ${JSON.stringify(input.body)}::jsonb, ${input.topic ?? null}, ${input.requirementId ?? null}::uuid, ${actor.id}::uuid)
      RETURNING id
    `);
    await audit(tx, { actorType: 'admin', actorId: actor.id, action: 'canned.create', targetType: 'canned_response', targetId: r.rows[0]!.id, metadata: { code: input.code }, requestId });
    return r.rows[0]!.id;
  });
  return (await listCanned(db, false)).items.find((c) => c.id === id)!;
}

export async function patchCanned(db: Db, actor: AdminContext, id: string, input: PatchCannedInput, requestId: string): Promise<CannedResponse> {
  if (input.body) validateCannedBody(input.body);
  await db.transaction(async (tx) => {
    const cur = await tx.execute(sql`SELECT 1 FROM canned_responses WHERE id = ${id}::uuid FOR UPDATE`);
    if (cur.rows.length === 0) throw AppError.notFound('Canned response not found.');
    await assertRequirementExists(tx, input.requirementId);
    const sets: SQL[] = [sql`updated_by = ${actor.id}::uuid`];
    if (input.title !== undefined) sets.push(sql`title = ${input.title}`);
    if (input.body !== undefined) sets.push(sql`body = ${JSON.stringify(input.body)}::jsonb`);
    if (input.topic !== undefined) sets.push(sql`topic = ${input.topic}`);
    if (input.requirementId !== undefined) sets.push(sql`requirement_id = ${input.requirementId}::uuid`);
    if (input.isActive !== undefined) sets.push(sql`is_active = ${input.isActive}`);
    await tx.execute(sql`UPDATE canned_responses SET ${sql.join(sets, sql`, `)} WHERE id = ${id}::uuid`);
    await audit(tx, { actorType: 'admin', actorId: actor.id, action: 'canned.update', targetType: 'canned_response', targetId: id, metadata: { fields: Object.keys(input).sort() }, requestId });
  });
  return (await listCanned(db, false)).items.find((c) => c.id === id)!;
}
