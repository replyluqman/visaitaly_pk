import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { as, asAdmin, call, env, login, newAdminIdentity, newUser, store, type TestAdmin, type TestUser } from './helpers/app.js';
import { closePool, q, resetDb, seedAdmin, seedCatalogue, seedLegal, seedTemplates } from './helpers/db.js';
import { createDb } from '../src/db/client.js';
import { purgeSupport } from '../src/modules/support/support.service.js';
import { processErasures, processExports } from '../src/modules/privacy/privacy.service.js';

let ops: ReturnType<typeof asAdmin>;
let opsId: string;
let opsIdentity: TestAdmin;

beforeEach(async () => {
  await resetDb();
  // Tests edit these config rows; restore the migration defaults so no test inherits another's.
  await q(`UPDATE app_config SET value = '{"support_paid_hours": 24, "support_free_hours": 48, "working_hours_windows": {"utc_offset_minutes": 300, "days": [1,2,3,4,5,6], "start_minute": 540, "end_minute": 1080}}'::jsonb WHERE key='sla'`);
  await q(`UPDATE app_config SET value = '{"topics_free": ["presales","app_problem","account"], "messages_per_hour": 20, "attachment_max_bytes": 5242880, "attachment_upload_ttl_seconds": 900, "retention_months": 24}'::jsonb WHERE key='support'`);
  store.objects.clear();
  await seedLegal();
  await seedTemplates();
  opsIdentity = newAdminIdentity();
  opsId = await seedAdmin(opsIdentity, { scopes: ['support_manage'] });
  ops = asAdmin(opsIdentity);
});
afterAll(closePool);

async function withDb<T>(fn: (db: Awaited<ReturnType<typeof createDb>>['db']) => Promise<T>): Promise<T> {
  const { db, close } = await createDb({ ...env, HYPERDRIVE: { connectionString: process.env.TEST_DATABASE_URL! } });
  try { return await fn(db); } finally { await close(); }
}
async function onboarded(paid = false): Promise<TestUser> {
  const id = (await q<{ id: string }>(`SELECT id FROM legal_versions WHERE is_current`))[0]!.id;
  const u = newUser();
  await login(u);
  await as(u)('POST', '/v1/legal/accept', { versionIds: [id] });
  const r = await as(u)('POST', '/v1/applicants', { displayName: 'Ayesha', relationshipCode: 'wife', currentLocation: 'pakistan', currentStage: 'documents' });
  if (paid) await q(`UPDATE applicants SET premium_status='active', access_until=now()+interval '30 days' WHERE id=$1`, [r.body.applicant.id]);
  return u;
}
const userId = async (u: TestUser) => (await q<{ id: string }>(`SELECT id FROM users WHERE firebase_uid=$1`, [u.uid]))[0]!.id;
const send = (u: TestUser, body: object) => as(u)('POST', '/v1/support/messages', body);
const hello = (extra: object = {}) => ({ body: 'Where is my payment?', topic: 'presales', ...extra });
const PNG = (n = 64) => { const b = new Uint8Array(n); b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); return b; };
const thread = async (u: TestUser) => (await q<any>(`SELECT * FROM support_threads WHERE user_id=$1`, [await userId(u)]))[0];
const setSla = (windows: object, extra: object = {}) =>
  q(`UPDATE app_config SET value = value || $1::jsonb WHERE key='sla'`, [JSON.stringify({ working_hours_windows: windows, ...extra })]);
const ALWAYS = { utc_offset_minutes: 0, days: [1, 2, 3, 4, 5, 6, 7], start_minute: 0, end_minute: 1440 };
const path = (url: string) => url.replace('http://t', '');

describe('thread + sending', () => {
  it('no thread yet: status none, free topics, no unread, no working-hours text until the CMS sets it', async () => {
    const u = await onboarded();
    expect((await as(u)('GET', '/v1/support/thread')).body).toEqual({
      status: 'none', tier: 'free', slaDueAt: null, unreadCount: 0, workingHoursText: null,
      allowedTopics: ['account', 'app_problem', 'presales'].sort((a, b) => ['payment','order','courier','refund','account','app_problem','presales'].indexOf(a) - ['payment','order','courier','refund','account','app_problem','presales'].indexOf(b)),
    });
    expect((await call('GET', '/v1/support/thread')).status).toBe(401);
  });

  it('first message creates the single thread, awaits support, and sets the SLA from the tier (config-driven hours)', async () => {
    await setSla(ALWAYS);
    const free = await onboarded();
    const paid = await onboarded(true);
    const t0 = Date.now();
    const m = await send(free, hello());
    expect(m.status).toBe(201);
    expect(m.body).toMatchObject({ senderType: 'user', body: 'Where is my payment?', topic: 'presales', attachment: null });
    await send(paid, hello({ topic: 'payment' }));
    const hours = (t: any) => Math.round((new Date(t.sla_due_at).getTime() - t0) / 3_600_000);
    const ft = await thread(free);
    const pt = await thread(paid);
    expect([ft.status, ft.tier, hours(ft)]).toEqual(['awaiting_support', 'free', 48]);
    expect([pt.status, pt.tier, hours(pt)]).toEqual(['awaiting_support', 'paid', 24]);
    expect(await q(`SELECT 1 FROM support_threads`)).toHaveLength(2);
    expect((await as(free)('GET', '/v1/support/thread')).body).toMatchObject({ status: 'awaiting_support', tier: 'free' });
  });

  it('the SLA counts WORKING hours only: a Sunday-only-off window pushes the deadline out', async () => {
    await setSla({ utc_offset_minutes: 0, days: [1], start_minute: 0, end_minute: 60 }); // Mondays, one hour a week
    const u = await onboarded(true);
    const t0 = Date.now();
    await send(u, hello({ topic: 'payment' }));
    const due = new Date((await thread(u)).sla_due_at).getTime();
    expect(due - t0).toBeGreaterThan(24 * 3_600_000); // far more than 24 wall-clock hours
  });

  it('a follow-up does NOT move the deadline; an admin reply stops the clock; the next user message restarts it', async () => {
    await setSla(ALWAYS);
    const u = await onboarded();
    await send(u, hello());
    const first = (await thread(u)).sla_due_at;
    await new Promise((r) => setTimeout(r, 25));
    await send(u, hello({ body: 'Any news?' }));
    expect((await thread(u)).sla_due_at).toEqual(first);

    const tid = (await thread(u)).id;
    await ops('POST', `/v1/admin/support/threads/${tid}/messages`, { body: 'Checking now.', topic: 'presales' });
    const afterReply = await thread(u);
    expect([afterReply.status, afterReply.sla_due_at]).toEqual(['awaiting_user', null]);
    await new Promise((r) => setTimeout(r, 25));
    await send(u, hello({ body: 'Thanks' }));
    const again = await thread(u);
    expect(again.status).toBe('awaiting_support');
    // deadlines are minute-granular, so a restart within the same minute lands on the same instant
    expect(new Date(again.sla_due_at).getTime()).toBeGreaterThanOrEqual(new Date(first).getTime());
  });

  it('topics follow the TIER (config): free → payment is 403 SUPPORT_TOPIC_NOT_ALLOWED; paid may use all; removing a free topic in config takes effect', async () => {
    const free = await onboarded();
    const paid = await onboarded(true);
    const denied = await send(free, hello({ topic: 'payment' }));
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('SUPPORT_TOPIC_NOT_ALLOWED');
    expect(await q(`SELECT 1 FROM support_messages`)).toHaveLength(0);
    for (const topic of ['payment', 'order', 'courier', 'refund', 'account', 'app_problem', 'presales']) {
      expect((await send(paid, hello({ topic }))).status).toBe(201);
    }
    await q(`UPDATE app_config SET value = jsonb_set(value,'{topics_free}','["presales"]') WHERE key='support'`);
    try {
      expect((await send(free, hello({ topic: 'account' }))).status).toBe(403);
      expect((await send(free, hello({ topic: 'presales' }))).status).toBe(201);
    } finally {
      await q(`UPDATE app_config SET value = jsonb_set(value,'{topics_free}','["presales","app_problem","account"]') WHERE key='support'`);
    }
  });

  it('tier follows premium status at send time (an upgrade unlocks topics; a lapse relocks them)', async () => {
    const u = await onboarded();
    expect((await send(u, hello({ topic: 'courier' }))).status).toBe(403);
    await q(`UPDATE applicants SET premium_status='active', access_until=now()+interval '30 days'`);
    expect((await send(u, hello({ topic: 'courier' }))).status).toBe(201);
    expect((await thread(u)).tier).toBe('paid');
    await q(`UPDATE applicants SET premium_status='expired'`);
    expect((await send(u, hello({ topic: 'courier' }))).status).toBe(403);
  });

  it('validation: needs text or an attachment, ≤ 4000 chars, known topic, own applicant', async () => {
    const u = await onboarded();
    const other = await onboarded();
    const otherApplicant = (await q<{ id: string }>(`SELECT a.id FROM applicants a JOIN users x ON x.id=a.user_id WHERE x.firebase_uid=$1`, [other.uid]))[0]!.id;
    for (const body of [{}, hello({ body: '' }), hello({ body: '   ' }), hello({ body: 'x'.repeat(4001) }), hello({ topic: 'chitchat' }), { body: 'hi' }, hello({ applicantId: 'nope' })]) {
      expect((await send(u, body)).status).toBe(422);
    }
    expect((await send(u, hello({ applicantId: otherApplicant }))).status).toBe(404);
    expect((await send(u, hello({ body: 'x'.repeat(4000) }))).status).toBe(201);
    expect((await call('POST', '/v1/support/messages', { body: hello() })).status).toBe(401);
  });

  it('rate limited per user per hour (config)', async () => {
    const u = await onboarded();
    await q(`UPDATE app_config SET value = jsonb_set(value,'{messages_per_hour}','2') WHERE key='support'`);
    try {
      expect((await send(u, hello())).status).toBe(201);
      expect((await send(u, hello())).status).toBe(201);
      const r = await send(u, hello());
      expect(r.status).toBe(429);
      expect(r.body.error.code).toBe('RATE_LIMITED');
      const other = await onboarded();
      expect((await send(other, hello())).status).toBe(201); // limit is per user
    } finally {
      await q(`UPDATE app_config SET value = jsonb_set(value,'{messages_per_hour}','20') WHERE key='support'`);
    }
  });

  it('a message to a closed thread reopens it', async () => {
    const u = await onboarded();
    await send(u, hello());
    const tid = (await thread(u)).id;
    await ops('POST', `/v1/admin/support/threads/${tid}/close`);
    expect((await thread(u)).status).toBe('closed');
    await send(u, hello({ body: 'One more thing' }));
    expect((await thread(u))).toMatchObject({ status: 'awaiting_support', closed_at: null });
  });
});

describe('messages + unread', () => {
  it('lists the thread newest first with a keyset (exact below the millisecond); only my own', async () => {
    const u = await onboarded();
    const other = await onboarded();
    await send(other, hello({ body: 'not yours' }));
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await send(u, hello({ body: `m${i}` }))).body.id);
    const stamps = ['2030-01-01 00:00:00.123900+00', '2030-01-01 00:00:00.123456+00', '2030-01-01 00:00:00.123100+00'];
    for (const [i, id] of ids.entries()) await q(`UPDATE support_messages SET created_at=$2::timestamptz WHERE id=$1`, [id, stamps[i]]);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const r: any = await as(u)('GET', `/v1/support/messages?limit=1${cursor ? `&cursor=${cursor}` : ''}`);
      seen.push(...r.body.items.map((m: any) => m.id));
      cursor = r.body.nextCursor;
    } while (cursor);
    expect(seen).toEqual(ids);
    for (const qs of ['limit=0', 'limit=51', 'cursor=@@']) expect((await as(u)('GET', `/v1/support/messages?${qs}`)).status).toBe(422);
    expect((await as(u)('GET', '/v1/support/messages')).body.items.every((m: any) => m.body.startsWith('m'))).toBe(true);
  });

  it('admin replies are unread until the user opens the thread', async () => {
    const u = await onboarded();
    await send(u, hello());
    const tid = (await thread(u)).id;
    await ops('POST', `/v1/admin/support/threads/${tid}/messages`, { body: 'Hello', topic: 'presales' });
    await ops('POST', `/v1/admin/support/threads/${tid}/messages`, { body: 'And again', topic: 'presales' });
    expect((await as(u)('GET', '/v1/support/thread')).body.unreadCount).toBe(2);
    expect((await as(u)('POST', '/v1/support/read')).status).toBe(204);
    expect((await as(u)('GET', '/v1/support/thread')).body.unreadCount).toBe(0);
  });
});

describe('attachments (images, R2)', () => {
  async function upload(u: TestUser, bytes = PNG(), mime = 'image/png') {
    const r = await as(u)('POST', '/v1/support/attachments/upload-url', { mime, sizeBytes: bytes.length });
    expect(r.status).toBe(200);
    expect((await call('PUT', path(r.body.uploadUrl), { bytes, headers: { 'Content-Length': String(bytes.length), 'Content-Type': mime } })).status).toBe(204);
    return r.body.id as string;
  }

  it('reserve → PUT → send with attachmentId: verified from storage, attached to the message, viewable by a signed URL', async () => {
    const u = await onboarded();
    const att = await upload(u);
    const m = await send(u, hello({ body: '', attachmentId: att }));
    expect(m.status).toBe(201);
    expect(m.body.attachment).toEqual({ id: att, mime: 'image/png' });
    expect((await q<{ status: string }>(`SELECT status FROM support_attachments`))[0]!.status).toBe('attached');
    const v = await as(u)('GET', `/v1/support/attachments/${att}`);
    const bytes = await call('GET', path(v.body.url));
    expect(bytes.status).toBe(200);
    expect(bytes.headers.get('Cache-Control')).toBe('private, no-store');
    expect(Array.from(bytes.bytes)).toEqual(Array.from(PNG()));
  });

  it('wrong type, wrong size, over the cap, and bad signatures are all refused', async () => {
    const u = await onboarded();
    expect((await as(u)('POST', '/v1/support/attachments/upload-url', { mime: 'application/pdf', sizeBytes: 10 })).status).toBe(422);
    await q(`UPDATE app_config SET value = jsonb_set(value,'{attachment_max_bytes}','100') WHERE key='support'`);
    try {
      const big = await as(u)('POST', '/v1/support/attachments/upload-url', { mime: 'image/png', sizeBytes: 101 });
      expect(big.status).toBe(413);
      expect(big.body.error.code).toBe('UPLOAD_TOO_LARGE');
    } finally {
      await q(`UPDATE app_config SET value = jsonb_set(value,'{attachment_max_bytes}','5242880') WHERE key='support'`);
    }
    const r = await as(u)('POST', '/v1/support/attachments/upload-url', { mime: 'image/png', sizeBytes: 64 });
    const url = path(r.body.uploadUrl);
    expect((await call('PUT', url, { bytes: PNG(65), headers: { 'Content-Length': '65', 'Content-Type': 'image/png' } })).status).toBe(422);
    expect((await call('PUT', url.replace(/sig=[^&]+/, 'sig=AAAA'), { bytes: PNG(), headers: { 'Content-Length': '64', 'Content-Type': 'image/png' } })).status).toBe(404);

    // an .exe renamed to PNG: bytes don't match → rejected at send, object discarded
    const evil = new Uint8Array(64); evil.set([0x4d, 0x5a]);
    const id = await upload(u, evil);
    const res = await send(u, hello({ attachmentId: id }));
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('UPLOAD_REJECTED');
    expect(store.objects.size).toBe(0);
    expect(await q(`SELECT 1 FROM support_messages`)).toHaveLength(0);
  });

  it('ownership: another user cannot attach, view, or sign someone else\'s attachment (404)', async () => {
    const a = await onboarded();
    const b = await onboarded();
    const att = await upload(a);
    expect((await send(b, hello({ attachmentId: att }))).status).toBe(404);
    await send(a, hello({ attachmentId: att }));
    expect((await as(b)('GET', `/v1/support/attachments/${att}`)).status).toBe(404);
    expect(await q(`SELECT 1 FROM support_messages WHERE user_id=$1`, [await userId(b)])).toHaveLength(0);
  });
});

describe('admin inbox + scopes', () => {
  it('401 anonymous; other scope 403; read_only reads, never writes; scoped admin and super do both', async () => {
    expect((await call('GET', '/v1/admin/support/threads')).status).toBe(401);
    const other = newAdminIdentity();
    await seedAdmin(other, { scopes: ['pricing_config'] });
    const ro = newAdminIdentity();
    await seedAdmin(ro, { scopes: ['read_only'] });
    const u = await onboarded();
    await send(u, hello());
    const tid = (await thread(u)).id;
    expect((await asAdmin(other)('GET', '/v1/admin/support/threads')).status).toBe(403);
    expect((await asAdmin(ro)('GET', '/v1/admin/support/threads')).status).toBe(200);
    expect((await asAdmin(ro)('POST', `/v1/admin/support/threads/${tid}/messages`, { body: 'x', topic: 'presales' })).status).toBe(403);
    expect((await asAdmin(ro)('POST', '/v1/admin/canned-responses', {})).status).toBe(403);
  });

  it('awaiting-support threads are sorted by SLA deadline; breach flagged; assignee filters; keyset', async () => {
    const us = [await onboarded(), await onboarded(), await onboarded()];
    for (const u of us) await send(u, hello({ body: `from ${u.uid}` }));
    const ts = await q<{ id: string; user_id: string }>(`SELECT id, user_id FROM support_threads`);
    const dueOrder = [2, 0, 1];
    for (const [i, t] of ts.entries()) await q(`UPDATE support_threads SET sla_due_at = now() + make_interval(hours => $2::int) WHERE id=$1`, [t.id, (dueOrder[i]! - 1) * 10 + 5]);
    // make the earliest one breached
    const earliest = ts[dueOrder.indexOf(0)]!;
    await q(`UPDATE support_threads SET sla_due_at = now() - interval '2 hours' WHERE id=$1`, [earliest.id]);
    const list = await ops('GET', '/v1/admin/support/threads');
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(3);
    expect(list.body.items[0]).toMatchObject({ id: earliest.id, breached: true, status: 'awaiting_support', tier: 'free' });
    expect(list.body.items[0].lastMessagePreview).toMatch(/^from /);
    const dues = list.body.items.map((t: any) => new Date(t.slaDueAt).getTime());
    expect([...dues].sort((a, b) => a - b)).toEqual(dues);

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const r: any = await ops('GET', `/v1/admin/support/threads?limit=1${cursor ? `&cursor=${cursor}` : ''}`);
      seen.push(...r.body.items.map((t: any) => t.id));
      cursor = r.body.nextCursor;
    } while (cursor);
    expect(seen).toEqual(list.body.items.map((t: any) => t.id));

    await ops('POST', `/v1/admin/support/threads/${earliest.id}/assign`, { adminId: opsId });
    expect((await ops('GET', '/v1/admin/support/threads?assignee=me')).body.items.map((t: any) => t.id)).toEqual([earliest.id]);
    expect((await ops('GET', '/v1/admin/support/threads?assignee=unassigned')).body.items).toHaveLength(2);
    expect((await ops('GET', '/v1/admin/support/summary')).body).toEqual({ awaitingSupport: 3, breached: 1, unassigned: 2 });
    for (const qs of ['status=weird', 'limit=0', 'cursor=@@', 'assignee=bob']) expect((await ops('GET', `/v1/admin/support/threads?${qs}`)).status).toBe(422);
  });

  it('other states list newest activity first', async () => {
    const a = await onboarded();
    const b = await onboarded();
    await send(a, hello()); await send(b, hello());
    for (const u of [a, b]) await ops('POST', `/v1/admin/support/threads/${(await thread(u)).id}/messages`, { body: 'ok', topic: 'presales' });
    const r = await ops('GET', '/v1/admin/support/threads?status=awaiting_user');
    expect(r.body.items).toHaveLength(2);
    expect(r.body.items.every((t: any) => t.slaDueAt === null && t.breached === false)).toBe(true);
  });

  it('thread detail: messages with authors + the side-panel context; 404 for an unknown thread', async () => {
    const u = await onboarded(true);
    await send(u, hello({ topic: 'payment' }));
    const tid = (await thread(u)).id;
    await ops('POST', `/v1/admin/support/threads/${tid}/messages`, { body: 'On it', topic: 'payment' });
    const d = await ops('GET', `/v1/admin/support/threads/${tid}`);
    expect(d.body.thread).toMatchObject({ id: tid, status: 'awaiting_user', tier: 'paid' });
    expect(d.body.context.email).toBe(u.email);
    expect(d.body.context.applicants).toEqual([expect.objectContaining({ relationshipCode: 'wife', currentStage: 'documents', premiumStatus: 'active' })]);
    expect(d.body.messages.map((m: any) => [m.senderType, m.adminId === opsId || m.adminId === null])).toEqual([['admin', true], ['user', true]]);
    expect((await ops('GET', '/v1/admin/support/threads/00000000-0000-4000-8000-000000000000')).status).toBe(404);
    expect((await ops('GET', '/v1/admin/support/threads/nope')).status).toBe(422);
  });
});

describe('operator replies — the scope boundary is enforced by tooling (PRD §10)', () => {
  it('free text: topic required, verdict language refused, otherwise sent, audited WITHOUT the body, and the user is notified', async () => {
    const u = await onboarded();
    await send(u, hello());
    const tid = (await thread(u)).id;
    const reply = (body: object) => ops('POST', `/v1/admin/support/threads/${tid}/messages`, body);
    expect((await reply({ body: 'Hi' })).status).toBe(422); // no topic
    for (const bad of ['You are eligible for this visa.', 'We advise you to apply now', 'Guaranteed to be approved']) {
      const r = await reply({ body: bad, topic: 'presales' });
      expect(r.status).toBe(422);
      expect(r.body.error.details.body[0]).toMatch(/advice or a verdict/);
    }
    expect((await reply({})).status).toBe(422);
    expect((await reply({ body: 'x', cannedResponseId: '00000000-0000-4000-8000-000000000000', topic: 'presales' })).status).toBe(422);
    expect(await q(`SELECT 1 FROM support_messages WHERE sender_type='admin'`)).toHaveLength(0);

    const ok = await reply({ body: 'Your payment is being verified.', topic: 'payment' });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ senderType: 'admin', body: 'Your payment is being verified.', topic: 'payment' });
    expect(await thread(u)).toMatchObject({ status: 'awaiting_user', sla_due_at: null, assigned_admin_id: opsId });
    const inbox = await as(u)('GET', '/v1/notifications?tab=activity');
    expect(inbox.body.items.map((n: any) => [n.type, n.deepLink])).toEqual([['support_reply', '/support']]);
    const [log] = await q<{ actor_id: string; metadata: any }>(`SELECT actor_id, metadata FROM audit_log WHERE action='support.reply'`);
    expect(log).toMatchObject({ actor_id: opsId, metadata: { canned: false, topic: 'payment' } });
    expect(JSON.stringify(log)).not.toContain('being verified');
  });

  it('a missing notification template never loses the reply (it is logged, not thrown)', async () => {
    const u = await onboarded();
    await send(u, hello());
    await q(`DELETE FROM notification_templates WHERE type='support_reply'`);
    const r = await ops('POST', `/v1/admin/support/threads/${(await thread(u)).id}/messages`, { body: 'Hello', topic: 'presales' });
    expect(r.status).toBe(201);
    expect(await q(`SELECT 1 FROM support_messages WHERE sender_type='admin'`)).toHaveLength(1);
  });

  describe('canned responses', () => {
    async function requirementFor(u: TestUser) {
      const cat = await seedCatalogue([{ code: 'passport', stage: 'documents', sort: 1 }]);
      void cat;
      await as(u)('PATCH', `/v1/applicants/${(await q<{ id: string }>(`SELECT id FROM applicants`))[0]!.id}/stage`, { currentStage: 'eligibility' });
      await as(u)('PATCH', `/v1/applicants/${(await q<{ id: string }>(`SELECT id FROM applicants`))[0]!.id}/stage`, { currentStage: 'documents' });
      return (await q<{ id: string }>(`SELECT id FROM requirements WHERE code='passport'`))[0]!.id;
    }
    const CANNED = (over: object = {}) => ({
      code: 'req_link', title: 'Requirement link', topic: 'presales',
      body: { en: 'Details for {requirement_title}: {requirement_deep_link}. Verified {verified_days_ago} days ago against {source_name}. See {how_we_verify_link}.' }, ...over,
    });

    it('create validates: code, English body, verdict language, unknown placeholders, duplicate, missing requirement', async () => {
      for (const body of [{}, CANNED({ code: 'Bad Code' }), CANNED({ body: { ur: 'x' } }), CANNED({ body: { en: 'You are eligible!' } }),
        CANNED({ body: { en: 'Order {order_ref}' } }), CANNED({ topic: 'chitchat' }), CANNED({ requirementId: '00000000-0000-4000-8000-000000000000' })]) {
        expect((await ops('POST', '/v1/admin/canned-responses', body)).status).toBe(422);
      }
      expect((await ops('POST', '/v1/admin/canned-responses', CANNED())).status).toBe(201);
      expect((await ops('POST', '/v1/admin/canned-responses', CANNED())).status).toBe(409);
    });

    it('a requirement-link response is rendered from the thread\'s REAL context (the user\'s own checklist item)', async () => {
      const u = await onboarded(true);
      const reqId = await requirementFor(u);
      await q(`UPDATE requirements SET last_verified_at = now() - interval '12 days' WHERE id=$1`, [reqId]);
      await send(u, hello({ topic: 'presales', body: 'What do I need for my passport?' }));
      const c = (await ops('POST', '/v1/admin/canned-responses', CANNED({ requirementId: reqId }))).body;
      const tid = (await thread(u)).id;
      const r = await ops('POST', `/v1/admin/support/threads/${tid}/messages`, { cannedResponseId: c.id });
      expect(r.status).toBe(201);
      const itemId = (await q<{ id: string }>(`SELECT ar.id FROM applicant_requirements ar JOIN requirements r ON r.id=ar.requirement_id WHERE r.code='passport'`))[0]!.id;
      expect(r.body.body).toBe(`Details for passport: /checklist/${itemId}. Verified 12 days ago against Test Source. See /how-we-verify.`);
      const [log] = await q<{ metadata: any }>(`SELECT metadata FROM audit_log WHERE action='support.reply'`);
      expect(log!.metadata).toMatchObject({ canned: 'req_link' });
      expect(r.body.topic).toBe('presales');
    });

    it('missing context is a 422 that names what is missing — never a half-filled message', async () => {
      const u = await onboarded();
      await send(u, hello());
      const tid = (await thread(u)).id;
      const noReq = (await ops('POST', '/v1/admin/canned-responses', CANNED({ code: 'no_req' }))).body; // placeholders but no requirement
      const r1 = await ops('POST', `/v1/admin/support/threads/${tid}/messages`, { cannedResponseId: noReq.id });
      expect(r1.status).toBe(422);
      expect(r1.body.error.details.cannedResponseId[0]).toContain('{requirement_title}');
      const hours = (await ops('POST', '/v1/admin/canned-responses', { code: 'hours', title: 'Hours', topic: 'presales', body: { en: 'We reply during {working_hours_text}.' } })).body;
      const r2 = await ops('POST', `/v1/admin/support/threads/${tid}/messages`, { cannedResponseId: hours.id });
      expect(r2.body.error.details.cannedResponseId[0]).toContain('{working_hours_text}');
      await q(`UPDATE app_config SET value = value || '{"working_hours_text": {"en": "Mon–Sat 9–6"}}'::jsonb WHERE key='sla'`);
      const r3 = await ops('POST', `/v1/admin/support/threads/${tid}/messages`, { cannedResponseId: hours.id });
      expect(r3.status).toBe(201);
      expect(r3.body.body).toBe('We reply during Mon–Sat 9–6.');
      expect((await as(u)('GET', '/v1/support/thread')).body.workingHoursText).toBe('Mon–Sat 9–6');
      expect(await q(`SELECT 1 FROM support_messages WHERE sender_type='admin'`)).toHaveLength(1);
    });

    it('patch, deactivate (409 on use), active filter; unknown id 404', async () => {
      const u = await onboarded();
      await send(u, hello());
      const tid = (await thread(u)).id;
      const c = (await ops('POST', '/v1/admin/canned-responses', { code: 'hello', title: 'Hello', topic: 'presales', body: { en: 'Hello there.' } })).body;
      const p = await ops('PATCH', `/v1/admin/canned-responses/${c.id}`, { title: 'Greeting', body: { en: 'Hi.' }, isActive: false });
      expect(p.body).toMatchObject({ title: 'Greeting', body: { en: 'Hi.' }, isActive: false });
      expect((await ops('POST', `/v1/admin/support/threads/${tid}/messages`, { cannedResponseId: c.id })).status).toBe(409);
      expect((await ops('GET', '/v1/admin/canned-responses?active=true')).body.items).toEqual([]);
      expect((await ops('GET', '/v1/admin/canned-responses')).body.items).toHaveLength(1);
      expect((await ops('PATCH', `/v1/admin/canned-responses/${c.id}`, {})).status).toBe(422);
      expect((await ops('PATCH', `/v1/admin/canned-responses/${c.id}`, { body: { en: 'We advise you to…' } })).status).toBe(422);
      expect((await ops('PATCH', '/v1/admin/canned-responses/00000000-0000-4000-8000-000000000000', { title: 'x' })).status).toBe(404);
    });
  });

  it('assign validates the assignee (active admin with support access); close/reopen transitions; all audited', async () => {
    const u = await onboarded();
    await send(u, hello());
    const tid = (await thread(u)).id;
    const noSupport = newAdminIdentity();
    const nsId = await seedAdmin(noSupport, { scopes: ['pricing_config'] });
    expect((await ops('POST', `/v1/admin/support/threads/${tid}/assign`, { adminId: nsId })).status).toBe(422);
    expect((await ops('POST', `/v1/admin/support/threads/${tid}/assign`, { adminId: opsId })).body.assignedAdminId).toBe(opsId);
    expect((await ops('POST', `/v1/admin/support/threads/${tid}/assign`, { adminId: null })).body.assignedAdminId).toBeNull();
    expect((await ops('POST', `/v1/admin/support/threads/${tid}/assign`, {})).status).toBe(422);
    expect((await ops('POST', `/v1/admin/support/threads/${tid}/reopen`)).status).toBe(409);
    expect((await ops('POST', `/v1/admin/support/threads/${tid}/close`)).body).toMatchObject({ status: 'closed', slaDueAt: null });
    expect((await ops('POST', `/v1/admin/support/threads/${tid}/close`)).status).toBe(409);
    expect((await ops('POST', `/v1/admin/support/threads/${tid}/reopen`)).body.status).toBe('awaiting_user');
    const actions = (await q<{ action: string }>(`SELECT action FROM audit_log WHERE target_id=$1 ORDER BY created_at, id`, [tid])).map((a) => a.action);
    expect(actions).toEqual(['support.assign', 'support.assign', 'support.close', 'support.reopen']);
  });

  it('an operator viewing a user\'s image is audited; the URL works', async () => {
    const u = await onboarded();
    const r = await as(u)('POST', '/v1/support/attachments/upload-url', { mime: 'image/png', sizeBytes: 64 });
    await call('PUT', path(r.body.uploadUrl), { bytes: PNG(), headers: { 'Content-Length': '64', 'Content-Type': 'image/png' } });
    await send(u, hello({ body: '', attachmentId: r.body.id }));
    const url = await ops('GET', `/v1/admin/support/attachments/${r.body.id}/url`);
    expect((await call('GET', path(url.body.url))).status).toBe(200);
    expect(await q(`SELECT 1 FROM audit_log WHERE action='support.view_attachment'`)).toHaveLength(1);
    expect((await ops('GET', '/v1/admin/support/attachments/00000000-0000-4000-8000-000000000000/url')).status).toBe(404);
  });
});

describe('retention + privacy integration', () => {
  it('closed threads are deleted 24 months after their last message, with their R2 objects; open ones and recent ones stay; abandoned uploads go', async () => {
    const old = await onboarded();
    const recent = await onboarded();
    const open = await onboarded();
    const r = await as(old)('POST', '/v1/support/attachments/upload-url', { mime: 'image/png', sizeBytes: 64 });
    await call('PUT', path(r.body.uploadUrl), { bytes: PNG(), headers: { 'Content-Length': '64', 'Content-Type': 'image/png' } });
    await send(old, hello({ attachmentId: r.body.id }));
    await send(recent, hello()); await send(open, hello());
    for (const u of [old, recent]) await ops('POST', `/v1/admin/support/threads/${(await thread(u)).id}/close`);
    await q(`UPDATE support_threads SET last_message_at = now() - interval '25 months' WHERE user_id=$1`, [await userId(old)]);
    await q(`UPDATE support_threads SET last_message_at = now() - interval '5 months' WHERE user_id=$1`, [await userId(recent)]);
    await q(`UPDATE support_threads SET last_message_at = now() - interval '30 months' WHERE user_id=$1`, [await userId(open)]);
    const stray = await as(open)('POST', '/v1/support/attachments/upload-url', { mime: 'image/png', sizeBytes: 64 });
    await call('PUT', path(stray.body.uploadUrl), { bytes: PNG(), headers: { 'Content-Length': '64', 'Content-Type': 'image/png' } });
    await q(`UPDATE support_attachments SET created_at = now() - interval '1 day' WHERE id=$1`, [stray.body.id]);

    const out = await withDb((db) => purgeSupport(db, store));
    expect(out).toEqual({ threads: 1, attachments: 2 });
    expect(await q(`SELECT 1 FROM support_threads`)).toHaveLength(2);
    expect(await q(`SELECT 1 FROM support_messages WHERE user_id=$1`, [await userId(old)])).toHaveLength(0);
    expect(store.objects.size).toBe(0);
  });

  it('account erasure removes threads, messages and attachment objects (objects first); the export includes the conversation', async () => {
    const u = await onboarded();
    const bystander = await onboarded();
    const up = await as(u)('POST', '/v1/support/attachments/upload-url', { mime: 'image/png', sizeBytes: 64 });
    await call('PUT', path(up.body.uploadUrl), { bytes: PNG(), headers: { 'Content-Length': '64', 'Content-Type': 'image/png' } });
    await send(u, hello({ body: 'My question', attachmentId: up.body.id }));
    await send(bystander, hello({ body: 'Theirs' }));

    await as(u)('POST', '/v1/account/data-export');
    await withDb((db) => processExports(db, store));
    const key = (await q<{ r2_export_key: string }>(`SELECT r2_export_key FROM data_requests WHERE kind='export'`))[0]!.r2_export_key;
    const exported = JSON.parse(new TextDecoder().decode(store.objects.get(key)!.bytes));
    expect(exported.supportMessages).toEqual([expect.objectContaining({ sender: 'user', body: 'My question', hasAttachment: true })]);
    expect(JSON.stringify(exported)).not.toContain('Theirs');

    await call('DELETE', '/v1/account', { uid: u.uid, email: u.email, deviceId: u.deviceId, body: { confirm: true } });
    for (let i = 0; i < 5; i++) await withDb((db) => processErasures(db, store, undefined));
    const uid = await userId(u).catch(() => null);
    void uid;
    expect(await q(`SELECT 1 FROM support_threads t JOIN users x ON x.id=t.user_id WHERE x.status='deleted'`)).toHaveLength(0);
    expect(await q(`SELECT 1 FROM support_attachments`)).toHaveLength(0);
    expect([...store.objects.keys()].some((k) => k.startsWith('support/'))).toBe(false);
    expect(await q(`SELECT 1 FROM support_threads`)).toHaveLength(1); // the bystander's thread is untouched
  });
});
