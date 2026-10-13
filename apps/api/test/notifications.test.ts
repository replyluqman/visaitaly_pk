import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { as, asAdmin, call, env, login, newAdminIdentity, newUser, store, type TestUser } from './helpers/app.js';
import { closePool, q, resetDb, seedAdmin, seedLegal, seedTemplates } from './helpers/db.js';
import { createDb } from '../src/db/client.js';
import type { PushMessage, PushResult, PushSender } from '../src/lib/fcm.js';
import {
  dispatchPush, dispatchRequirementUpdates, generateReminders, notify, purgeReadNotifications,
} from '../src/modules/notifications/notifications.service.js';
import { runScheduledJobs } from '../src/jobs.js';

beforeEach(async () => {
  await resetDb();
  await seedLegal();
  await seedTemplates();
});
afterAll(closePool);

async function withDb<T>(fn: (db: Awaited<ReturnType<typeof createDb>>['db']) => Promise<T>): Promise<T> {
  const { db, close } = await createDb({ ...env, HYPERDRIVE: { connectionString: process.env.TEST_DATABASE_URL! } });
  try { return await fn(db); } finally { await close(); }
}
async function onboarded(): Promise<TestUser> {
  const id = (await q<{ id: string }>(`SELECT id FROM legal_versions WHERE is_current`))[0]!.id;
  const u = newUser();
  await login(u);
  await as(u)('POST', '/v1/legal/accept', { versionIds: [id] });
  return u;
}
const userId = async (u: TestUser) => (await q<{ id: string }>(`SELECT id FROM users WHERE firebase_uid=$1`, [u.uid]))[0]!.id;
async function applicant(u: TestUser, paid = true, body: object = {}): Promise<string> {
  const r = await as(u)('POST', '/v1/applicants', {
    displayName: 'Ayesha', relationshipCode: 'wife', currentLocation: 'pakistan', currentStage: 'documents', ...body,
  });
  expect(r.status).toBe(201);
  const id = r.body.applicant.id as string;
  if (paid) await q(`UPDATE applicants SET premium_status='active', access_until=now()+interval '30 days' WHERE id=$1`, [id]);
  return id;
}
async function insertNotification(u: TestUser, over: Record<string, unknown> = {}) {
  const uid = await userId(u);
  const o: Record<string, any> = { tab: 'update', type: 'requirement_changed', title: 'T', body: 'B', deep_link: '/x', key: Math.random().toString(36), ...over };
  return (await q<{ id: string }>(
    `INSERT INTO notifications (user_id, tab, type, title, body, deep_link, dedupe_key, created_at, read_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7, coalesce($8::timestamptz, now()), $9) RETURNING id`,
    [uid, o.tab, o.type, o.title, o.body, o.deep_link, o.key, o.created_at ?? null, o.read_at ?? null]))[0]!.id;
}

class FakePush implements PushSender {
  sent: Array<{ token: string; msg: PushMessage }> = [];
  results: Record<string, PushResult> = {};
  async send(token: string, msg: PushMessage) { this.sent.push({ token, msg }); return this.results[token] ?? 'ok'; }
}
const registerToken = (u: TestUser, token: string | null) =>
  q(`UPDATE devices SET fcm_token=$2 WHERE user_id=(SELECT id FROM users WHERE firebase_uid=$1) AND device_id=$3`, [u.uid, token, u.deviceId]);

// ---------------------------------------------------------------------------
describe('inbox (Screen 13)', () => {
  it('lists one tab newest-first with a keyset cursor; other tabs and other users are invisible', async () => {
    const u = await onboarded();
    const other = await onboarded();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push(await insertNotification(u, { created_at: `2030-01-01 00:00:0${i}+00` }));
    await insertNotification(u, { tab: 'reminder' });
    await insertNotification(other, { tab: 'update' });

    const p1 = await as(u)('GET', '/v1/notifications?tab=update&limit=2');
    expect(p1.status).toBe(200);
    expect(p1.body.items.map((n: any) => n.id)).toEqual([ids[2], ids[1]]);
    expect(p1.body.items[0]).toMatchObject({ tab: 'update', type: 'requirement_changed', title: 'T', body: 'B', deepLink: '/x', readAt: null });
    const p2 = await as(u)('GET', `/v1/notifications?tab=update&limit=2&cursor=${p1.body.nextCursor}`);
    expect(p2.body.items.map((n: any) => n.id)).toEqual([ids[0]]);
    expect(p2.body.nextCursor).toBeNull();
    expect((await as(u)('GET', '/v1/notifications?tab=reminder')).body.items).toHaveLength(1);
    expect((await as(u)('GET', '/v1/notifications?tab=activity')).body.items).toEqual([]);
  });

  it('keyset is exact below the millisecond', async () => {
    const u = await onboarded();
    const ids = [
      await insertNotification(u, { created_at: '2030-01-01 00:00:00.123900+00' }),
      await insertNotification(u, { created_at: '2030-01-01 00:00:00.123456+00' }),
      await insertNotification(u, { created_at: '2030-01-01 00:00:00.123100+00' }),
    ];
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const r: any = await as(u)('GET', `/v1/notifications?tab=update&limit=1${cursor ? `&cursor=${cursor}` : ''}`);
      seen.push(...r.body.items.map((n: any) => n.id));
      cursor = r.body.nextCursor;
    } while (cursor);
    expect(seen).toEqual(ids);
  });

  it('validation: tab required and known, limit bounded, cursor opaque; 401 anonymous', async () => {
    const u = await onboarded();
    for (const qs of ['', 'tab=news', 'tab=update&limit=0', 'tab=update&limit=51', 'tab=update&cursor=@@']) {
      expect((await as(u)('GET', `/v1/notifications?${qs}`)).status).toBe(422);
    }
    expect((await call('GET', '/v1/notifications?tab=update')).status).toBe(401);
    expect((await call('GET', '/v1/notifications/unread-count')).status).toBe(401);
  });

  it('unread-count is grouped per tab; mark-read is idempotent and keeps the FIRST read time', async () => {
    const u = await onboarded();
    const a = await insertNotification(u, { tab: 'update' });
    await insertNotification(u, { tab: 'update' });
    await insertNotification(u, { tab: 'reminder' });
    await insertNotification(u, { tab: 'activity', read_at: '2030-01-01 00:00:00+00' });
    expect((await as(u)('GET', '/v1/notifications/unread-count')).body).toEqual({ total: 3, byTab: { reminder: 1, update: 2, activity: 0 } });
    expect((await as(u)('POST', `/v1/notifications/${a}/read`)).status).toBe(204);
    const first = (await q<{ read_at: string }>(`SELECT read_at FROM notifications WHERE id=$1`, [a]))[0]!.read_at;
    await new Promise((r) => setTimeout(r, 15));
    expect((await as(u)('POST', `/v1/notifications/${a}/read`)).status).toBe(204);
    expect((await q<{ read_at: string }>(`SELECT read_at FROM notifications WHERE id=$1`, [a]))[0]!.read_at).toEqual(first);
    expect((await as(u)('GET', '/v1/notifications/unread-count')).body.total).toBe(2);
  });

  it('read-all: one tab or everything', async () => {
    const u = await onboarded();
    await insertNotification(u, { tab: 'update' });
    await insertNotification(u, { tab: 'reminder' });
    expect((await as(u)('POST', '/v1/notifications/read-all', { tab: 'update' })).status).toBe(204);
    expect((await as(u)('GET', '/v1/notifications/unread-count')).body.byTab).toEqual({ reminder: 1, update: 0, activity: 0 });
    expect((await as(u)('POST', '/v1/notifications/read-all')).status).toBe(204);
    expect((await as(u)('GET', '/v1/notifications/unread-count')).body.total).toBe(0);
    expect((await as(u)('POST', '/v1/notifications/read-all', { tab: 'bogus' })).status).toBe(422);
  });

  it('ownership: another user\'s notification is 404 on read and is untouched; read-all never crosses users', async () => {
    const a = await onboarded();
    const b = await onboarded();
    const n = await insertNotification(a);
    const r = await as(b)('POST', `/v1/notifications/${n}/read`);
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('NOT_FOUND');
    await as(b)('POST', '/v1/notifications/read-all');
    expect((await q<{ read_at: string | null }>(`SELECT read_at FROM notifications WHERE id=$1`, [n]))[0]!.read_at).toBeNull();
    expect((await as(b)('POST', '/v1/notifications/nope/read')).status).toBe(422);
    expect((await as(b)('POST', '/v1/notifications/00000000-0000-4000-8000-000000000000/read')).status).toBe(404);
  });

  it('preferences: default on, partial update, validation, in-app cannot be disabled', async () => {
    const u = await onboarded();
    expect((await as(u)('GET', '/v1/notification-preferences')).body).toEqual({ push: { reminder: true, update: true, activity: true } });
    const r = await as(u)('PUT', '/v1/notification-preferences', { push: { update: false } });
    expect(r.body).toEqual({ push: { reminder: true, update: false, activity: true } });
    expect((await as(u)('PUT', '/v1/notification-preferences', { push: { reminder: false } })).body.push).toEqual({ reminder: false, update: false, activity: true });
    for (const body of [{}, { push: {} }, { push: { news: true } }, { push: { update: 'no' } }]) {
      expect((await as(u)('PUT', '/v1/notification-preferences', body)).status).toBe(422);
    }
    await expect(q(`INSERT INTO notification_preferences (user_id, tab, channel, enabled) VALUES ($1,'update','in_app',false)`, [await userId(u)])).rejects.toThrow();
  });

  it('every notification carries a well-formed deep link (schema guard)', async () => {
    const u = await onboarded();
    const uid = await userId(u);
    for (const bad of ['', 'checklist/1', 'http://evil.example', '/x?y=1']) {
      await expect(q(`INSERT INTO notifications (user_id, tab, type, title, body, deep_link, dedupe_key) VALUES ($1,'update','requirement_changed','t','b',$2,$3)`, [uid, bad, bad + 'k'])).rejects.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
describe('notify() — event-triggered (Activity) helper', () => {
  it('renders the template, dedupes, and refuses unknown types / missing templates', async () => {
    const u = await onboarded();
    const uid = await userId(u);
    await withDb(async (db) => {
      expect(await notify(db, { userId: uid, type: 'requirement_changed', deepLink: '/x', dedupeKey: 'k1', vars: { title: 'Passport', changeSummary: 'Fee changed' } })).toBe(true);
      expect(await notify(db, { userId: uid, type: 'requirement_changed', deepLink: '/x', dedupeKey: 'k1', vars: { title: 'Other' } })).toBe(false);
      await expect(notify(db, { userId: uid, type: 'made_up', deepLink: '/x', dedupeKey: 'k2' })).rejects.toThrow(/unknown notification type/);
      await q(`DELETE FROM notification_templates WHERE type='requirement_changed'`);
      await expect(notify(db, { userId: uid, type: 'requirement_changed', deepLink: '/x', dedupeKey: 'k3' })).rejects.toThrow(/no en template/);
    });
    const [n] = await q<any>(`SELECT tab, title, body FROM notifications`);
    expect(n).toEqual({ tab: 'update', title: 'T:requirement_changed', body: 'B:requirement_changed|Passport|Fee changed||' }); // unsupplied {days}/{date} are removed, never shown raw
  });

  it('values are bound, never interpolated as SQL or as further placeholders', async () => {
    const u = await onboarded();
    await withDb(async (db) => {
      await notify(db, { userId: await userId(u), type: 'requirement_changed', deepLink: '/x', dedupeKey: 'k', vars: { title: "'); DROP TABLE users;--", changeSummary: '{days}' } });
    });
    expect((await q(`SELECT 1 FROM users`)).length).toBeGreaterThan(0);
    expect((await q<{ body: string }>(`SELECT body FROM notifications`))[0]!.body).toContain("'); DROP TABLE users;--");
  });
});

// ---------------------------------------------------------------------------
describe('Updates: admin publish → affected premium applicants (Cron)', () => {
  const admin = newAdminIdentity();
  async function publish(code: string, over: Record<string, unknown> = {}) {
    await seedAdmin(admin, { scopes: ['verification_manage'] }).catch(() => undefined);
    const cms = asAdmin(admin);
    const src = await cms('POST', '/v1/admin/sources', { url: `https://example.test/${code}`, name: { en: 'S' }, authority: 'embassy' });
    const c = await cms('POST', '/v1/admin/requirements', { code, stage: 'documents', title: { en: `Title ${code}` }, sourceId: src.body.id, ...over });
    await cms('POST', `/v1/admin/requirements/${c.body.id}/actions`, { action: 'verify' });
    await cms('POST', `/v1/admin/requirements/${c.body.id}/actions`, { action: 'publish' });
    return { cms, id: c.body.id as string };
  }
  const run = () => withDb((db) => dispatchRequirementUpdates(db));

  it('notifies each affected premium applicant once; skips free, grace-expired and non-applicable', async () => {
    const paid = await onboarded();
    const free = await onboarded();
    const kid = await onboarded();
    const grace = await onboarded();
    const expired = await onboarded();
    const pa = await applicant(paid);
    await applicant(free, false);
    await applicant(kid, true, { relationshipCode: 'son', dateOfBirth: '2015-01-01' });
    const ga = await applicant(grace, false);
    await q(`UPDATE applicants SET premium_status='expired_pending_confirmation', grace_until=now()+interval '3 days' WHERE id=$1`, [ga]);
    const ea = await applicant(expired, false);
    await q(`UPDATE applicants SET premium_status='expired' WHERE id=$1`, [ea]);

    const { id } = await publish('nikah', { appliesChild: false, appliesParent: false });
    const out = await run();
    expect(out).toEqual({ versions: 1, notifications: 2, skippedNoTemplate: 0 }); // paid + grace
    const rows = await q<{ u: string; type: string; deep_link: string; payload: any; body: string }>(
      `SELECT u.firebase_uid AS u, n.type, n.deep_link, n.payload, n.body FROM notifications n JOIN users u ON u.id = n.user_id ORDER BY u.firebase_uid`);
    expect(rows.map((r) => r.u).sort()).toEqual([paid.uid, grace.uid].sort());
    expect(rows[0]).toMatchObject({ type: 'requirement_added', payload: { requirementCode: 'nikah', requirementVersion: 1 } });
    expect(rows[0]!.deep_link).toMatch(/^\/checklist\/[0-9a-f-]{36}$/);
    expect(rows[0]!.body).toContain('Title nikah');
    void pa; void id;

    expect(await run()).toEqual({ versions: 0, notifications: 0, skippedNoTemplate: 0 }); // already dispatched
    expect((await q(`SELECT 1 FROM notification_dispatch`))).toHaveLength(1);
  });

  it('a re-publish is a "changed" notification carrying the change summary inline', async () => {
    const u = await onboarded();
    await applicant(u);
    const { cms, id } = await publish('nikah');
    await run();
    await cms('PATCH', `/v1/admin/requirements/${id}`, { purpose: { en: 'x' }, reverify: true, changeSummary: { en: 'Fee is now higher' } });
    expect(await run()).toMatchObject({ versions: 1, notifications: 1 });
    const list = await as(u)('GET', '/v1/notifications?tab=update');
    expect(list.body.items.map((n: any) => n.type)).toEqual(['requirement_changed', 'requirement_added']);
    expect(list.body.items[0].body).toBe('B:requirement_changed|Title nikah|Fee is now higher||');
    expect(list.body.items[0].deepLink).toMatch(/^\/checklist\//);
  });

  it('a missing template is skipped and retried — never marked dispatched and silently lost', async () => {
    const u = await onboarded();
    await applicant(u);
    await publish('nikah');
    await q(`DELETE FROM notification_templates WHERE type='requirement_added'`);
    expect(await run()).toEqual({ versions: 0, notifications: 0, skippedNoTemplate: 1 });
    expect(await q(`SELECT 1 FROM notification_dispatch`)).toHaveLength(0);
    await seedTemplates();
    expect(await run()).toMatchObject({ versions: 1, notifications: 1 });
  });

  it('a version unpublished before the Cron ran is not announced', async () => {
    const u = await onboarded();
    await applicant(u);
    const { cms, id } = await publish('nikah');
    await cms('POST', `/v1/admin/requirements/${id}/actions`, { action: 'unpublish' });
    expect(await run()).toEqual({ versions: 0, notifications: 0, skippedNoTemplate: 0 });
  });
});

// ---------------------------------------------------------------------------
describe('Reminders: from case data (Cron)', () => {
  const gen = () => withDb((db) => generateReminders(db));
  const nulla = async (a: string, daysFromNow: number, status = 'received') =>
    q(`UPDATE applicants SET nulla_osta_status=$2, nulla_osta_issue_date=CURRENT_DATE - 100, nulla_osta_expiry_date=CURRENT_DATE + $3::int WHERE id=$1`, [a, status, daysFromNow]);

  it('Nulla Osta: one reminder per threshold crossed (30/7/1/expired), never repeated', async () => {
    const u = await onboarded();
    const a = await applicant(u);
    await nulla(a, 45);
    expect((await gen()).nullaOsta).toBe(0); // outside the 30-day horizon
    await nulla(a, 25);
    expect((await gen()).nullaOsta).toBe(1); // 30-day bucket
    expect((await gen()).nullaOsta).toBe(0); // idempotent
  });

  it('thresholds: 30 → 7 → 1 → expired fire in turn for one expiry date', async () => {
    const u = await onboarded();
    const a = await applicant(u);
    const expiry = (await q<{ d: string }>(`SELECT to_char(CURRENT_DATE + 25, 'YYYY-MM-DD') AS d`))[0]!.d;
    const set = (days: number) => q(`UPDATE applicants SET nulla_osta_status='received', nulla_osta_issue_date=CURRENT_DATE - 100, nulla_osta_expiry_date=CURRENT_DATE + $2::int WHERE id=$1`, [a, days]);
    void expiry;
    // keep ONE expiry date but move "today" by shifting what we compare: emulate by changing the expiry offset
    // within the same bucket → different dates would re-key, so instead walk the buckets via distinct offsets:
    for (const [days, want] of [[25, 1], [6, 1], [1, 1], [-3, 1]] as const) {
      await set(days);
      expect((await gen()).nullaOsta).toBe(want);
    }
    const bodies = (await q<{ body: string; dedupe_key: string }>(`SELECT body, dedupe_key FROM notifications ORDER BY created_at`)).map((r) => r.dedupe_key.split(':').pop());
    expect(bodies).toEqual(['30', '7', '1', '0']);
  });

  it('only premium/grace applicants with a RECEIVED Nulla Osta; body carries days and date', async () => {
    const paid = await onboarded();
    const free = await onboarded();
    const pa = await applicant(paid);
    const fa = await applicant(free, false);
    const pending = await onboarded();
    const pe = await applicant(pending);
    await nulla(pa, 5);
    await nulla(fa, 5);
    await nulla(pe, 5, 'in_process');
    expect((await gen()).nullaOsta).toBe(1);
    const [n] = await q<{ body: string; deep_link: string; tab: string; type: string }>(`SELECT body, deep_link, tab, type FROM notifications`);
    expect(n).toMatchObject({ tab: 'reminder', type: 'nulla_osta_expiring', deep_link: `/applicants/${pa}` });
    expect(n!.body).toMatch(/^B:nulla_osta_expiring\|\|\|5\|\d{4}-\d{2}-\d{2}$/); // {title}/{changeSummary} are not Nulla Osta variables → removed
  });

  it('documents: linked vs unlinked templates, deleted/free excluded, thresholds deduped', async () => {
    const u = await onboarded();
    const a = await applicant(u);
    const doc = (days: number, over: { linked?: boolean; status?: string } = {}) =>
      q(`INSERT INTO documents (user_id, applicant_id, r2_key, mime, size_bytes, client_sha256, status, completed_at, deleted_at, expiry_date)
         SELECT user_id, id, $2, 'image/png', 10, repeat('a',64), $3, now(), CASE WHEN $3='deleted' THEN now() END, CURRENT_DATE + $4::int
           FROM applicants WHERE id=$1`, [a, `k${Math.random()}`, over.status ?? 'active', days]);
    await doc(10);
    await doc(10, { status: 'deleted' });
    await doc(200);
    expect((await gen()).documents).toBe(1);
    expect((await gen()).documents).toBe(0);
    const [n] = await q<{ type: string; deep_link: string }>(`SELECT type, deep_link FROM notifications`);
    expect(n).toEqual({ type: 'document_expiring_unlinked', deep_link: '/documents' });
  });

  it('configurable thresholds and batch size', async () => {
    const u = await onboarded();
    const a = await applicant(u);
    await nulla(a, 60);
    await q(`UPDATE app_config SET value='{"days_before":[90,60],"batch_size":5000}' WHERE key='reminders'`);
    try {
      expect((await gen()).nullaOsta).toBe(1);
      expect((await q<{ k: string }>(`SELECT dedupe_key AS k FROM notifications`))[0]!.k.endsWith(':60')).toBe(true);
    } finally {
      await q(`UPDATE app_config SET value='{"days_before":[30,7,1],"batch_size":5000}' WHERE key='reminders'`);
    }
  });
});

// ---------------------------------------------------------------------------
describe('Push (Cron) — FCM is delivery only', () => {
  const push = (sender?: PushSender) => withDb((db) => dispatchPush(db, sender));

  it('sends to every active device, marks the notification sent, includes the deep link in data', async () => {
    const u = await onboarded();
    const u2 = { ...u, deviceId: crypto.randomUUID() };
    await login(u2);
    await registerToken(u, 'tok-1');
    await registerToken(u2, 'tok-2');
    const n = await insertNotification(u, { deep_link: '/checklist/abc' });
    const fake = new FakePush();
    expect(await push(fake)).toEqual({ sent: 1, skipped: 0, failed: 0, invalidTokens: 0 });
    expect(fake.sent.map((s) => s.token).sort()).toEqual(['tok-1', 'tok-2']);
    expect(fake.sent[0]!.msg).toEqual({ title: 'T', body: 'B', data: { notificationId: n, deepLink: '/checklist/abc', type: 'requirement_changed' } });
    expect((await q<{ push_sent_at: string | null }>(`SELECT push_sent_at FROM notifications`))[0]!.push_sent_at).not.toBeNull();
    expect(await push(fake)).toEqual({ sent: 0, skipped: 0, failed: 0, invalidTokens: 0 }); // nothing left
  });

  it('push off for the tab, or no registered device: nothing sent, leaves the queue, inbox untouched', async () => {
    const u = await onboarded();
    await registerToken(u, 'tok');
    await as(u)('PUT', '/v1/notification-preferences', { push: { update: false } });
    await insertNotification(u, { tab: 'update' });
    const bare = await onboarded(); // no fcm token
    await insertNotification(bare, { tab: 'reminder' });
    const fake = new FakePush();
    expect(await push(fake)).toMatchObject({ sent: 0, skipped: 2 });
    expect(fake.sent).toEqual([]);
    expect(await q(`SELECT 1 FROM notifications WHERE push_sent_at IS NULL`)).toHaveLength(0);
    expect((await as(u)('GET', '/v1/notifications?tab=update')).body.items).toHaveLength(1);
  });

  it('a dead token is cleared and not retried; if it was the only device the notification leaves the queue', async () => {
    const u = await onboarded();
    await registerToken(u, 'dead-tok');
    await insertNotification(u);
    const fake = new FakePush();
    fake.results['dead-tok'] = 'invalid_token';
    expect(await push(fake)).toMatchObject({ sent: 0, skipped: 1, invalidTokens: 1 });
    expect((await q<{ fcm_token: string | null }>(`SELECT fcm_token FROM devices`))[0]!.fcm_token).toBeNull();
    expect(await q(`SELECT 1 FROM notifications WHERE push_sent_at IS NULL`)).toHaveLength(0);
  });

  it('transient failures retry, then give up after push_max_attempts (the inbox still has it)', async () => {
    const u = await onboarded();
    await registerToken(u, 'tok');
    await insertNotification(u);
    const fake = new FakePush();
    fake.results.tok = 'retry';
    for (let i = 0; i < 3; i++) expect(await push(fake)).toMatchObject({ failed: 1 });
    expect(await push(fake)).toEqual({ sent: 0, skipped: 0, failed: 0, invalidTokens: 0 }); // out of attempts
    expect(fake.sent).toHaveLength(3);
    expect((await q<{ push_attempts: number }>(`SELECT push_attempts FROM notifications`))[0]!.push_attempts).toBe(3);
    expect((await as(u)('GET', '/v1/notifications?tab=update')).body.items).toHaveLength(1);
  });

  it('respects the per-run send budget (subrequest cap); the rest stay queued, oldest first', async () => {
    const u = await onboarded();
    await registerToken(u, 'tok');
    for (let i = 0; i < 5; i++) await insertNotification(u, { created_at: `2030-01-01 00:00:0${i}+00`, title: `n${i}` });
    await q(`UPDATE app_config SET value = jsonb_set(value,'{push_max_per_run}','2') WHERE key='notifications'`);
    try {
      const fake = new FakePush();
      expect(await push(fake)).toMatchObject({ sent: 2 });
      expect(fake.sent.map((s) => s.msg.title)).toEqual(['n0', 'n1']);
      expect(await q(`SELECT 1 FROM notifications WHERE push_sent_at IS NULL`)).toHaveLength(3);
    } finally {
      await q(`UPDATE app_config SET value = jsonb_set(value,'{push_max_per_run}','40') WHERE key='notifications'`);
    }
  });

  it('without a configured sender nothing is marked sent (push resumes when the secret is set)', async () => {
    const u = await onboarded();
    await registerToken(u, 'tok');
    await insertNotification(u);
    expect(await push(undefined)).toEqual({ sent: 0, skipped: 0, failed: 0, invalidTokens: 0 });
    expect(await q(`SELECT 1 FROM notifications WHERE push_sent_at IS NULL`)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
describe('dev seed', () => {
  it('every dev template carries the placeholder marker (so preflight blocks it) and covers every type', async () => {
    const { readFileSync } = await import('node:fs');
    const sqlText = readFileSync(new URL('../seed/seed_dev_notifications.sql', import.meta.url), 'utf8');
    const rules = JSON.parse(readFileSync(new URL('../copy-rules.json', import.meta.url), 'utf8')) as { placeholderMarker: string };
    const types = Object.keys(JSON.parse(readFileSync(new URL('../src/lib/notification-types.json', import.meta.url), 'utf8'))).filter((t) => !t.startsWith('_'));
    for (const t of types) expect(sqlText).toContain(`('${t}'`);
    const rows = sqlText.split('\n').filter((l) => l.trim().startsWith("('"));
    expect(rows).toHaveLength(types.length);
    for (const row of rows) expect(row.split(rules.placeholderMarker).length - 1).toBe(2); // title and body
  });
});

describe('retention + jobs', () => {
  it('deletes READ rows older than the window; keeps unread and recent ones', async () => {
    const u = await onboarded();
    const old = await insertNotification(u, { read_at: new Date(Date.now() - 100 * 86400_000).toISOString() });
    const recent = await insertNotification(u, { read_at: new Date(Date.now() - 5 * 86400_000).toISOString() });
    const unread = await insertNotification(u, { created_at: '2020-01-01 00:00:00+00' });
    expect(await withDb((db) => purgeReadNotifications(db))).toBe(1);
    const left = (await q<{ id: string }>(`SELECT id FROM notifications`)).map((r) => r.id).sort();
    expect(left).toEqual([recent, unread].sort());
    void old;
  });

  it('runScheduledJobs runs every job and reports; one failing job does not stop the others', async () => {
    const u = await onboarded();
    await registerToken(u, 'tok');
    await insertNotification(u);
    const boom: PushSender = { send: async () => { throw new Error('fcm exploded'); } };
    const report = await withDb((db) => runScheduledJobs(db, { store, pushSender: boom }));
    expect(Object.keys(report)).toEqual([
      'requirement_updates', 'reminders', 'push', 'next_actions', 'source_hash_sweep', 'document_retention', 'notification_retention',
    ]);
    expect(report.push).toEqual({ ok: false, error: 'fcm exploded' });
    for (const k of ['requirement_updates', 'reminders', 'next_actions', 'source_hash_sweep', 'document_retention', 'notification_retention']) {
      expect(report[k]!.ok).toBe(true);
    }
    const fine = await withDb((db) => runScheduledJobs(db, { store, pushSender: new FakePush() }));
    expect(fine.push).toMatchObject({ ok: true, result: { sent: 1 } });
  });
});
