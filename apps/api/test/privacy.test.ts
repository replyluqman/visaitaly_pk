import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { as, call, env, login, newUser, store, type TestUser } from './helpers/app.js';
import { closePool, q, resetDb, seedLegal, seedTemplates } from './helpers/db.js';
import { createDb } from '../src/db/client.js';
import { processErasures, processExports } from '../src/modules/privacy/privacy.service.js';
import { createIdentityDeleter, type IdentityDeleter, type IdentityDeleteResult } from '../src/lib/identity.js';
import { createSign, generateKeyPairSync } from 'node:crypto';

beforeEach(async () => {
  await resetDb();
  store.objects.clear();
  store.failDeletes = false;
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
async function applicant(u: TestUser): Promise<string> {
  const r = await as(u)('POST', '/v1/applicants', {
    displayName: 'Ayesha Khan', relationshipCode: 'wife', currentLocation: 'pakistan', currentStage: 'documents',
  });
  return r.body.applicant.id;
}
async function addDocument(u: TestUser, applicantId: string, key: string) {
  store.objects.set(key, { bytes: new Uint8Array([1, 2, 3]), contentType: 'image/png' });
  await q(`INSERT INTO documents (user_id, applicant_id, r2_key, mime, size_bytes, client_sha256, status, completed_at)
           VALUES ($1,$2,$3,'image/png',3,repeat('a',64),'active',now())`, [await userId(u), applicantId, key]);
}
class FakeIdentity implements IdentityDeleter {
  calls: string[] = [];
  result: IdentityDeleteResult = 'deleted';
  async deleteUser(uid: string) { this.calls.push(uid); return this.result; }
}
const erase = (identity?: IdentityDeleter) => withDb((db) => processErasures(db, store, identity));
const exportsJob = () => withDb((db) => processExports(db, store));
const del = (u: TestUser, authAge?: number, over: { body?: unknown; rawBody?: string } = { body: { confirm: true } }) =>
  call('DELETE', '/v1/account', { uid: u.uid, email: u.email, deviceId: u.deviceId, authAge, ...over });

describe('consents (DATA-PRIVACY §2)', () => {
  it('everything is OFF and unanswered until the user answers; partial updates; policy version required', async () => {
    const u = await onboarded();
    expect((await as(u)('GET', '/v1/account/consents')).body).toEqual({
      analytics: false, crashReports: false, marketingPush: false, policyVersion: null, answered: false,
    });
    const r = await as(u)('PUT', '/v1/account/consents', { analytics: true, policyVersion: '1.0' });
    expect(r.body).toEqual({ analytics: true, crashReports: false, marketingPush: false, policyVersion: '1.0', answered: true });
    expect((await as(u)('PUT', '/v1/account/consents', { crashReports: true, analytics: false, policyVersion: '1.1' })).body)
      .toMatchObject({ analytics: false, crashReports: true, policyVersion: '1.1' });
    for (const body of [{}, { analytics: true }, { policyVersion: '1.0' }, { analytics: 'yes', policyVersion: '1.0' }, { analytics: true, policyVersion: '' }]) {
      expect((await as(u)('PUT', '/v1/account/consents', body)).status).toBe(422);
    }
    expect((await call('GET', '/v1/account/consents')).status).toBe(401);
  });

  it('are per user', async () => {
    const a = await onboarded();
    const b = await onboarded();
    await as(a)('PUT', '/v1/account/consents', { analytics: true, policyVersion: '1.0' });
    expect((await as(b)('GET', '/v1/account/consents')).body.analytics).toBe(false);
  });
});

describe('right of access: data export', () => {
  it('request → 202; a second while open is 409; after it completes the 24h cool-down returns 429 (config-driven)', async () => {
    const u = await onboarded();
    const r = await as(u)('POST', '/v1/account/data-export');
    expect(r.status).toBe(202);
    expect(r.body.status).toBe('received');
    expect((await as(u)('POST', '/v1/account/data-export')).status).toBe(409);
    await exportsJob();
    const cool = await as(u)('POST', '/v1/account/data-export');
    expect(cool.status).toBe(429);
    expect(cool.body.error.code).toBe('RATE_LIMITED');
    await q(`UPDATE app_config SET value = jsonb_set(value,'{export_cooldown_hours}','0') WHERE key='privacy'`);
    try {
      expect((await as(u)('POST', '/v1/account/data-export')).status).toBe(202);
    } finally {
      await q(`UPDATE app_config SET value = jsonb_set(value,'{export_cooldown_hours}','24') WHERE key='privacy'`);
    }
  });

  it('the Cron builds a private JSON with the user\'s own data only — no tokens, no other users — and announces it', async () => {
    const u = await onboarded();
    const other = await onboarded();
    const a = await applicant(u);
    await applicant(other);
    await addDocument(u, a, 'u/x/doc1');
    await q(`UPDATE devices SET fcm_token='SECRET-FCM-TOKEN' WHERE user_id=$1`, [await userId(u)]);
    await as(u)('PUT', '/v1/account/consents', { analytics: true, policyVersion: '1.0' });
    const { body: { requestId } } = await as(u)('POST', '/v1/account/data-export');
    expect(await exportsJob()).toEqual({ built: 1, expired: 0 });

    const [req] = await q<{ status: string; r2_export_key: string; expires_at: string }>(`SELECT status, r2_export_key, expires_at FROM data_requests`);
    expect(req!.status).toBe('completed');
    expect(req!.r2_export_key).toBe(`exports/${await userId(u)}/${requestId}.json`);
    const json = JSON.parse(new TextDecoder().decode(store.objects.get(req!.r2_export_key)!.bytes));
    expect(json.account.email).toBe(u.email);
    expect(json.applicants).toHaveLength(1);
    expect(json.applicants[0].displayName).toBe('Ayesha Khan');
    expect(json.documents).toHaveLength(1);
    expect(json.documents[0].apiPath).toMatch(/^\/v1\/documents\//);
    expect(json.consents).toHaveLength(1);
    expect(json.legalAcceptances).toHaveLength(1);
    expect(json.truncated).toBe(false);
    const text = JSON.stringify(json);
    expect(text).not.toContain('SECRET-FCM-TOKEN');
    expect(text).not.toContain(other.email);
    expect(text).not.toContain('r2_key');

    const inbox = await as(u)('GET', '/v1/notifications?tab=activity');
    expect(inbox.body.items).toHaveLength(1);
    expect(inbox.body.items[0]).toMatchObject({ type: 'data_export_ready', deepLink: `/account/exports/${requestId}` });
  });

  it('status + a short-lived download URL; wrong signature / expired / other user → 404; the file is an attachment, never cached', async () => {
    const u = await onboarded();
    const other = await onboarded();
    const { body: { requestId } } = await as(u)('POST', '/v1/account/data-export');
    expect((await as(u)('GET', `/v1/account/data-exports/${requestId}`)).body).toMatchObject({ status: 'received', downloadUrl: null });
    await exportsJob();
    const st = (await as(u)('GET', `/v1/account/data-exports/${requestId}`)).body;
    expect(st).toMatchObject({ id: requestId, status: 'completed' });
    expect(st.downloadUrl).toMatch(/\/content\?exp=\d+&sig=/);
    const dl = await call('GET', st.downloadUrl.replace('http://t', ''));
    expect(dl.status).toBe(200);
    expect(dl.headers.get('Content-Disposition')).toContain('attachment');
    expect(dl.headers.get('Cache-Control')).toBe('private, no-store');
    expect(JSON.parse(new TextDecoder().decode(dl.bytes)).account.email).toBe(u.email);

    expect((await call('GET', `/v1/account/data-exports/${requestId}/content?exp=1&sig=AAAA`)).status).toBe(404);
    expect((await call('GET', `/v1/account/data-exports/${requestId}/content`)).status).toBe(404);
    const r = await as(other)('GET', `/v1/account/data-exports/${requestId}`);
    expect(r.status).toBe(404);
    expect((await as(u)('GET', '/v1/account/data-exports/nope')).status).toBe(422);
    expect((await call('GET', `/v1/account/data-exports/${requestId}`)).status).toBe(401);
  });

  it('exports expire: the object is deleted, the request row stays as the compliance record, the URL stops working', async () => {
    const u = await onboarded();
    const { body: { requestId } } = await as(u)('POST', '/v1/account/data-export');
    await exportsJob();
    const url = (await as(u)('GET', `/v1/account/data-exports/${requestId}`)).body.downloadUrl as string;
    await q(`UPDATE data_requests SET expires_at = now() - interval '1 minute'`);
    expect((await call('GET', url.replace('http://t', ''))).status).toBe(404);
    expect(await exportsJob()).toEqual({ built: 0, expired: 1 });
    expect(store.objects.size).toBe(0);
    const [row] = await q<{ status: string; r2_export_key: string | null }>(`SELECT status, r2_export_key FROM data_requests`);
    expect(row).toEqual({ status: 'completed', r2_export_key: null });
    expect((await as(u)('GET', `/v1/account/data-exports/${requestId}`)).body.downloadUrl).toBeNull();
  });

  it('a failing build is recorded and retried, and gives up as `failed` after max attempts', async () => {
    const u = await onboarded();
    await as(u)('POST', '/v1/account/data-export');
    const original = store.put.bind(store);
    store.put = async () => { throw new Error('r2 down'); };
    await q(`UPDATE app_config SET value = jsonb_set(value,'{max_attempts}','2') WHERE key='privacy'`);
    try {
      await exportsJob();
      expect((await q<{ status: string; last_error: string }>(`SELECT status, last_error FROM data_requests`))[0]).toEqual({ status: 'processing', last_error: 'r2 down' });
      await exportsJob();
      expect((await q<{ status: string }>(`SELECT status FROM data_requests`))[0]!.status).toBe('failed');
      store.put = original;
      expect(await exportsJob()).toEqual({ built: 0, expired: 0 }); // failed requests are not retried silently
    } finally {
      store.put = original;
      await q(`UPDATE app_config SET value = jsonb_set(value,'{max_attempts}','10') WHERE key='privacy'`);
    }
  });
});

describe('right to erasure: request (synchronous half)', () => {
  it('needs {confirm:true} and a RECENT sign-in; otherwise nothing changes', async () => {
    const u = await onboarded();
    for (const over of [{ rawBody: '' }, { body: {} }, { body: { confirm: false } }, { body: { confirm: 'yes' } }]) {
      expect((await del(u, undefined, over)).status).toBe(422);
    }
    expect((await as(u)('GET', '/v1/me')).status).toBe(200); // none of the refused attempts did anything
    const stale = await del(u, 3600);
    expect(stale.status).toBe(401);
    expect(stale.body.error.code).toBe('REAUTH_REQUIRED');
    expect((await as(u)('GET', '/v1/me')).status).toBe(200);
    expect(await q(`SELECT 1 FROM data_requests`)).toHaveLength(0);
    expect((await call('DELETE', '/v1/account', { body: { confirm: true } })).status).toBe(401);
  });

  it('202: the account is unusable immediately (USER_DELETED), devices signed out, request queued', async () => {
    const u = await onboarded();
    const u2 = { ...u, deviceId: crypto.randomUUID() };
    await login(u2);
    const r = await del(u, 30);
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ status: 'received' });
    const me = await as(u)('GET', '/v1/me');
    expect(me.status).toBe(403);
    expect(me.body.error.code).toBe('USER_DELETED');
    expect((await as(u2)('GET', '/v1/me')).body.error.code).toBe('USER_DELETED');
    expect((await q<{ status: string }>(`SELECT DISTINCT status FROM devices`)).map((d) => d.status)).toEqual(['signed_out']);
    const [req] = await q<{ kind: string; status: string; firebase_uid: string }>(`SELECT kind, status, firebase_uid FROM data_requests`);
    expect(req).toEqual({ kind: 'delete', status: 'received', firebase_uid: u.uid });
    // login is refused too — and does not rewrite the row (Module 1 fix)
    expect((await login(u)).status).toBe(403);
  });

  it('a second deletion request is refused (already deleted)', async () => {
    const u = await onboarded();
    await del(u, 10);
    expect((await del(u, 10)).status).toBe(403);
    expect(await q(`SELECT 1 FROM data_requests WHERE kind='delete'`)).toHaveLength(1);
  });
});

describe('right to erasure: the Cron (asynchronous half)', () => {
  async function seeded() {
    const u = await onboarded();
    const bystander = await onboarded();
    const a = await applicant(u);
    const ba = await applicant(bystander);
    await addDocument(u, a, 'u/mine/1');
    await addDocument(u, a, 'u/mine/2');
    await addDocument(bystander, ba, 'u/theirs/1');
    await as(u)('PUT', '/v1/account/consents', { analytics: true, policyVersion: '1.0' });
    const { body: { requestId } } = await as(u)('POST', '/v1/account/data-export');
    await exportsJob();
    return { u, bystander, a, ba, requestId };
  }

  it('erases documents (objects first), exports, applicants and their cascade, notifications, devices, consents — keeps the tombstone and legal proof', async () => {
    const { u, bystander } = await seeded();
    const uid = await userId(u);
    await del(u, 10);
    const identity = new FakeIdentity();
    expect(await erase(identity)).toEqual({ completed: 1, inProgress: 0, failed: 0 });

    expect([...store.objects.keys()]).toEqual(['u/theirs/1']); // mine + the export file are gone, the bystander's stays
    for (const t of ['documents', 'applicants', 'applicant_requirements', 'next_actions', 'notifications', 'notification_preferences', 'consents', 'devices']) {
      expect(await q(`SELECT 1 FROM ${t} WHERE user_id = $1`, [uid]).catch(() => q(`SELECT 1 FROM ${t} WHERE false`))).toHaveLength(0);
    }
    const [user] = await q<any>(`SELECT email, display_name, status, firebase_uid, declared_applicant_count FROM users WHERE id=$1`, [uid]);
    expect(user).toEqual({ email: null, display_name: null, status: 'deleted', firebase_uid: `deleted:${uid}`, declared_applicant_count: null });
    expect(await q(`SELECT 1 FROM legal_acceptances WHERE user_id=$1`, [uid])).toHaveLength(1); // proof of consent is retained
    const [dr] = await q<any>(`SELECT status, firebase_uid, identity_deleted_at, last_error FROM data_requests WHERE kind='delete'`);
    expect(dr.status).toBe('completed');
    expect(dr.firebase_uid).toBeNull(); // the uid is not kept once the identity is gone
    expect(dr.identity_deleted_at).not.toBeNull();
    expect(identity.calls).toEqual([u.uid]);
    // the export request row survives as the compliance record, without its object
    expect((await q<any>(`SELECT r2_export_key FROM data_requests WHERE kind='export'`))[0].r2_export_key).toBeNull();

    // the bystander is untouched
    const bid = await userId(bystander);
    expect(await q(`SELECT 1 FROM applicants WHERE user_id=$1`, [bid])).toHaveLength(1);
    expect(await q(`SELECT 1 FROM documents WHERE user_id=$1`, [bid])).toHaveLength(1);
    expect((await as(bystander)('GET', '/v1/me')).status).toBe(200);
  });

  it('the object budget makes it resumable: rows are deleted only after their objects, across several ticks', async () => {
    const { u } = await seeded();
    await del(u, 10);
    await q(`UPDATE app_config SET value = jsonb_set(value,'{delete_objects_per_run}','1') WHERE key='privacy'`);
    try {
      const uid = await userId(u);
      expect(await erase(new FakeIdentity())).toMatchObject({ completed: 0, inProgress: 1 });
      expect(await q(`SELECT 1 FROM documents WHERE user_id=$1`, [uid])).toHaveLength(1); // one doc object+row gone, one left
      expect(await erase(new FakeIdentity())).toMatchObject({ inProgress: 1 });
      expect(await q(`SELECT 1 FROM documents WHERE user_id=$1`, [uid])).toHaveLength(0);
      expect(await erase(new FakeIdentity())).toMatchObject({ completed: 1 }); // the export object goes, then the rest
      expect(await erase(new FakeIdentity())).toEqual({ completed: 0, inProgress: 0, failed: 0 });
      expect([...store.objects.keys()]).toEqual(['u/theirs/1']);
    } finally {
      await q(`UPDATE app_config SET value = jsonb_set(value,'{delete_objects_per_run}','40') WHERE key='privacy'`);
    }
  });

  it('if R2 fails the rows are kept and the next tick retries — an object is never orphaned', async () => {
    const { u } = await seeded();
    const uid = await userId(u);
    await del(u, 10);
    store.failDeletes = true;
    expect(await erase(new FakeIdentity())).toMatchObject({ completed: 0, failed: 1 });
    expect(await q(`SELECT 1 FROM documents WHERE user_id=$1`, [uid])).toHaveLength(2);
    expect((await q<any>(`SELECT status, last_error FROM data_requests WHERE kind='delete'`))[0]).toEqual({ status: 'processing', last_error: 'r2 unavailable' });
    expect((await q<any>(`SELECT email FROM users WHERE id=$1`, [uid]))[0].email).toBe(u.email); // PII not touched until objects are gone
    store.failDeletes = false;
    expect(await erase(new FakeIdentity())).toMatchObject({ completed: 1 });
  });

  it('the Firebase login: retried until it succeeds; "not found" counts as done', async () => {
    const { u } = await seeded();
    await del(u, 10);
    const identity = new FakeIdentity();
    identity.result = 'retry';
    expect(await erase(identity)).toMatchObject({ completed: 0, failed: 1 });
    expect((await q<any>(`SELECT status, firebase_uid, last_error FROM data_requests WHERE kind='delete'`))[0]).toEqual({
      status: 'processing', firebase_uid: u.uid, last_error: 'identity deletion pending',
    });
    identity.result = 'not_found';
    expect(await erase(identity)).toMatchObject({ completed: 1 });
    expect((await q<any>(`SELECT identity_deleted_at FROM data_requests WHERE kind='delete'`))[0].identity_deleted_at).not.toBeNull();
  });

  it('with no identity deleter configured the data is still erased and the gap is RECORDED (uid kept for manual follow-up)', async () => {
    const { u } = await seeded();
    await del(u, 10);
    expect(await erase(undefined)).toMatchObject({ completed: 1 });
    expect((await q<any>(`SELECT status, firebase_uid, identity_deleted_at FROM data_requests WHERE kind='delete'`))[0]).toEqual({
      status: 'completed', firebase_uid: u.uid, identity_deleted_at: null,
    });
  });

  it('is idempotent: a second run finds nothing to do', async () => {
    const { u } = await seeded();
    await del(u, 10);
    await erase(new FakeIdentity());
    expect(await erase(new FakeIdentity())).toEqual({ completed: 0, inProgress: 0, failed: 0 });
  });

  it('the same Firebase account signing up again afterwards gets a brand-new, empty account', async () => {
    const { u } = await seeded();
    const oldId = await userId(u);
    await del(u, 10);
    await erase(new FakeIdentity());
    const again = await login(u);
    expect(again.status).toBe(201);
    expect(again.body.user.id).not.toBe(oldId);
    expect(again.body.applicants.total).toBe(0);
    expect(again.body.user.onboardingState).toBe('disclaimer_pending');
  });
});

describe('identity deleter (unit — real Firebase is exercised on staging)', () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const SA = JSON.stringify({
    client_email: 'x@proj.iam.gserviceaccount.com', project_id: 'proj-1',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  });
  void createSign;
  const mk = (handler: (url: string, init: RequestInit) => Response) =>
    createIdentityDeleter(SA, async (url, init) => (url.includes('oauth2') ? new Response(JSON.stringify({ access_token: 'AT', expires_in: 3600 })) : handler(url, init)));

  it('posts accounts:delete with the uid and a bearer token, and maps the responses', async () => {
    let seen: { url: string; body: string; auth: string } | undefined;
    const ok = mk((url, init) => { seen = { url, body: init.body as string, auth: (init.headers as Record<string, string>).Authorization! }; return new Response('{}'); });
    expect(await ok.deleteUser('uid-9')).toBe('deleted');
    expect(seen).toEqual({
      url: 'https://identitytoolkit.googleapis.com/v1/projects/proj-1/accounts:delete', body: '{"localId":"uid-9"}', auth: 'Bearer AT',
    });
    expect(await mk(() => new Response(JSON.stringify({ error: { message: 'USER_NOT_FOUND' } }), { status: 400 })).deleteUser('u')).toBe('not_found');
    expect(await mk(() => new Response('{}', { status: 404 })).deleteUser('u')).toBe('not_found');
    expect(await mk(() => new Response('{}', { status: 503 })).deleteUser('u')).toBe('retry');
    expect(await createIdentityDeleter(SA, async () => { throw new Error('net'); }).deleteUser('u')).toBe('retry');
  });
});
