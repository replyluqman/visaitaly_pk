import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { as, asAdmin, call, login, newAdminIdentity, newUser, type TestUser } from './helpers/app.js';
import { closePool, q, resetDb, seedAdmin, seedLegal } from './helpers/db.js';

let legal: ReturnType<typeof asAdmin>;
let legalId: string;

beforeEach(async () => {
  await resetDb();
  const a = newAdminIdentity();
  legalId = await seedAdmin(a, { scopes: ['legal_manage'] });
  legal = asAdmin(a);
});
afterAll(closePool);

const V = (over: Record<string, unknown> = {}) => ({
  docType: 'disclaimer', locale: 'en', version: '1.0', title: 'Disclaimer', bodyMd: 'Body text', ...over,
});
async function userAccepted(): Promise<TestUser> {
  const ids = (await q<{ id: string }>(`SELECT id FROM legal_versions WHERE is_current AND is_mandatory`)).map((r) => r.id);
  const u = newUser();
  await login(u);
  await as(u)('POST', '/v1/legal/accept', { versionIds: ids });
  return u;
}

describe('access (scope legal_manage)', () => {
  it('401 anonymous; other scope 403; read_only reads, never writes; super does both', async () => {
    expect((await call('GET', '/v1/admin/legal-versions')).status).toBe(401);
    const other = newAdminIdentity();
    await seedAdmin(other, { scopes: ['support_manage'] });
    const ro = newAdminIdentity();
    await seedAdmin(ro, { scopes: ['read_only'] });
    expect((await asAdmin(other)('GET', '/v1/admin/legal-versions')).status).toBe(403);
    expect((await asAdmin(ro)('GET', '/v1/admin/legal-versions')).status).toBe(200);
    expect((await asAdmin(ro)('POST', '/v1/admin/legal-versions', V())).status).toBe(403);
    expect((await legal('POST', '/v1/admin/legal-versions', V())).status).toBe(201);
  });
});

describe('versions (Screen 44)', () => {
  it('create validates, rejects a duplicate (doc, locale, version), stays a DRAFT until published', async () => {
    for (const body of [{}, V({ docType: 'cookies' }), V({ version: '' }), V({ title: '' }), V({ bodyMd: '' }), V({ locale: 'english' }), V({ version: 'x'.repeat(33) })]) {
      expect((await legal('POST', '/v1/admin/legal-versions', body)).status).toBe(422);
    }
    const c = await legal('POST', '/v1/admin/legal-versions', V());
    expect(c.status).toBe(201);
    expect(c.body).toMatchObject({ version: '1.0', isCurrent: false, publishedAt: null, publishedBy: null, isMandatory: true, acceptanceCount: 0 });
    expect((await legal('POST', '/v1/admin/legal-versions', V())).status).toBe(409);
    expect((await legal('POST', '/v1/admin/legal-versions', V({ locale: 'ur' }))).status).toBe(201); // same version, other locale
    expect((await q(`SELECT 1 FROM legal_versions WHERE is_current`))).toHaveLength(0);
  });

  it('a draft can be edited; a published version cannot — via the API or SQL', async () => {
    const c = (await legal('POST', '/v1/admin/legal-versions', V())).body;
    const p = await legal('PATCH', `/v1/admin/legal-versions/${c.id}`, { title: 'New title', bodyMd: 'New body', isMandatory: false });
    expect(p.body).toMatchObject({ title: 'New title', isMandatory: false });
    expect((await legal('PATCH', `/v1/admin/legal-versions/${c.id}`, {})).status).toBe(422);
    expect((await legal('PATCH', '/v1/admin/legal-versions/00000000-0000-4000-8000-000000000000', { title: 'x' })).status).toBe(404);

    await legal('POST', `/v1/admin/legal-versions/${c.id}/publish`);
    const blocked = await legal('PATCH', `/v1/admin/legal-versions/${c.id}`, { title: 'Sneaky' });
    expect(blocked.status).toBe(409);
    await expect(q(`UPDATE legal_versions SET body_md = 'tampered' WHERE id=$1`, [c.id])).rejects.toThrow(/immutable/);
    await expect(q(`UPDATE legal_versions SET version = '9.9' WHERE id=$1`, [c.id])).rejects.toThrow(/immutable/);
    await expect(q(`UPDATE legal_versions SET is_current = true WHERE id=$1`, [c.id])).resolves.toBeDefined(); // only is_current may move
  });

  it('publish: atomic switch — exactly one current per (doc, locale) — records who, audited, 409 if repeated', async () => {
    const v1 = (await legal('POST', '/v1/admin/legal-versions', V({ version: '1.0' }))).body;
    const v2 = (await legal('POST', '/v1/admin/legal-versions', V({ version: '1.1' }))).body;
    const terms = (await legal('POST', '/v1/admin/legal-versions', V({ docType: 'terms', version: '1.0' }))).body;
    const p1 = await legal('POST', `/v1/admin/legal-versions/${v1.id}/publish`);
    expect(p1.body).toMatchObject({ isCurrent: true, publishedBy: legalId });
    expect(p1.body.publishedAt).not.toBeNull();
    await legal('POST', `/v1/admin/legal-versions/${terms.id}/publish`);
    await legal('POST', `/v1/admin/legal-versions/${v2.id}/publish`);
    const cur = await q<{ doc_type: string; version: string }>(`SELECT doc_type, version FROM legal_versions WHERE is_current ORDER BY doc_type`);
    expect(cur).toEqual([{ doc_type: 'disclaimer', version: '1.1' }, { doc_type: 'terms', version: '1.0' }]);
    expect((await legal('POST', `/v1/admin/legal-versions/${v2.id}/publish`)).status).toBe(409);
    expect((await legal('POST', '/v1/admin/legal-versions/00000000-0000-4000-8000-000000000000/publish')).status).toBe(404);
    expect((await q(`SELECT 1 FROM audit_log WHERE action='legal.publish'`))).toHaveLength(3);
  });

  it('publishing a new version forces every user to re-accept on their next launch', async () => {
    const v1 = (await legal('POST', '/v1/admin/legal-versions', V({ version: '1.0' }))).body;
    await legal('POST', `/v1/admin/legal-versions/${v1.id}/publish`);
    const u = await userAccepted();
    expect((await as(u)('GET', '/v1/me')).body.legal.requiresAcceptance).toBe(false);
    const v2 = (await legal('POST', '/v1/admin/legal-versions', V({ version: '1.1', title: 'Updated' }))).body;
    await legal('POST', `/v1/admin/legal-versions/${v2.id}/publish`);
    const me = await as(u)('GET', '/v1/me');
    expect(me.body.legal).toEqual({ requiresAcceptance: true, pendingDocTypes: ['disclaimer'] });
    const doc = await as(u)('GET', '/v1/legal/current/disclaimer');
    expect(doc.body).toMatchObject({ version: '1.1', title: 'Updated', accepted: false });
    await as(u)('POST', '/v1/legal/accept', { versionIds: [v2.id] });
    expect((await as(u)('GET', '/v1/me')).body.legal.requiresAcceptance).toBe(false);
  });

  it('lists with filter + keyset and counts acceptances; acceptances are paged, user ids only, and the read is audited', async () => {
    const v1 = (await legal('POST', '/v1/admin/legal-versions', V({ version: '1.0' }))).body;
    await legal('POST', '/v1/admin/legal-versions', V({ docType: 'terms', version: '1.0' }));
    await legal('POST', `/v1/admin/legal-versions/${v1.id}/publish`);
    for (let i = 0; i < 3; i++) await userAccepted();
    const list = await legal('GET', '/v1/admin/legal-versions?docType=disclaimer');
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0]).toMatchObject({ id: v1.id, acceptanceCount: 3, isCurrent: true });
    const p1 = await legal('GET', `/v1/admin/legal-versions?limit=1`);
    expect(p1.body.items).toHaveLength(1);
    expect((await legal('GET', `/v1/admin/legal-versions?limit=1&cursor=${p1.body.nextCursor}`)).body.items).toHaveLength(1);
    expect((await legal('GET', '/v1/admin/legal-versions?cursor=@@')).status).toBe(422);

    const a1 = await legal('GET', `/v1/admin/legal-versions/${v1.id}/acceptances?limit=2`);
    expect(a1.body.items).toHaveLength(2);
    expect(Object.keys(a1.body.items[0]).sort()).toEqual(['acceptedAt', 'appVersion', 'userId']);
    const a2 = await legal('GET', `/v1/admin/legal-versions/${v1.id}/acceptances?limit=2&cursor=${a1.body.nextCursor}`);
    expect(a2.body.items).toHaveLength(1);
    expect(new Set([...a1.body.items, ...a2.body.items].map((x: any) => x.userId)).size).toBe(3);
    expect(await q(`SELECT 1 FROM audit_log WHERE action='legal.view_acceptances'`)).toHaveLength(2);
    expect((await legal('GET', '/v1/admin/legal-versions/00000000-0000-4000-8000-000000000000/acceptances')).status).toBe(404);
  });
});

describe('case lookup (Screen 36)', () => {
  const anyAdmin = async () => {
    const a = newAdminIdentity();
    const id = await seedAdmin(a, { scopes: ['read_only'] });
    return { api: asAdmin(a), id };
  };
  async function userWithCase() {
    await seedLegal();
    const u = await userAccepted();
    const r = await as(u)('POST', '/v1/applicants', { displayName: 'Ayesha Khan', relationshipCode: 'wife', currentLocation: 'pakistan', currentStage: 'documents' });
    return { u, applicantId: r.body.applicant.id as string };
  }

  it('finds by email or user id and returns a read-only picture; any active admin may; no tokens or documents', async () => {
    const { u, applicantId } = await userWithCase();
    await q(`UPDATE devices SET fcm_token = 'SECRET-TOKEN'`);
    const { api } = await anyAdmin();
    const byEmail = await api('GET', `/v1/admin/lookup?email=${encodeURIComponent(u.email.toUpperCase())}`);
    expect(byEmail.status).toBe(200);
    expect(byEmail.body.user).toMatchObject({ email: u.email, status: 'active', onboardingState: 'complete' });
    expect(byEmail.body.applicants).toEqual([expect.objectContaining({ id: applicantId, displayName: 'Ayesha Khan', currentStage: 'documents', premiumStatus: 'none' })]);
    expect(byEmail.body.devices).toHaveLength(1);
    expect(byEmail.body.legalAcceptances).toHaveLength(1);
    expect(JSON.stringify(byEmail.body)).not.toContain('SECRET-TOKEN');
    const byId = await api('GET', `/v1/admin/lookup?userId=${byEmail.body.user.id}`);
    expect(byId.body.user.id).toBe(byEmail.body.user.id);
  });

  it('exactly one key; unknown → 404; invalid → 422; anonymous 401; a non-admin 403', async () => {
    const { u } = await userWithCase();
    const { api } = await anyAdmin();
    for (const qs of ['', 'email=a@b.com&userId=00000000-0000-4000-8000-000000000000', 'email=not-an-email', 'userId=nope']) {
      expect((await api('GET', `/v1/admin/lookup?${qs}`)).status).toBe(422);
    }
    expect((await api('GET', '/v1/admin/lookup?email=nobody@example.com')).status).toBe(404);
    expect((await call('GET', `/v1/admin/lookup?email=${u.email}`)).status).toBe(401);
    expect((await asAdmin(newAdminIdentity())('GET', `/v1/admin/lookup?email=${u.email}`)).status).toBe(403);
  });

  it('EVERY lookup is audited — found or not — recording the key type and the user id, never the email', async () => {
    const { u } = await userWithCase();
    const { api, id } = await anyAdmin();
    const hit = await api('GET', `/v1/admin/lookup?email=${u.email}`);
    await api('GET', '/v1/admin/lookup?email=nobody@example.com');
    const log = await q<{ actor_id: string; target_type: string | null; target_id: string | null; metadata: any }>(
      `SELECT actor_id, target_type, target_id, metadata FROM audit_log WHERE action='case.lookup' ORDER BY created_at, id`);
    expect(log).toHaveLength(2);
    expect(log[0]).toEqual({ actor_id: id, target_type: 'user', target_id: hit.body.user.id, metadata: { by: 'email', found: true } });
    expect(log[1]).toEqual({ actor_id: id, target_type: 'user', target_id: null, metadata: { by: 'email', found: false } });
    expect(JSON.stringify(log)).not.toContain('@');
  });

  it('shows a deleted account as the tombstone it is, with its data requests', async () => {
    const { u } = await userWithCase();
    const { api } = await anyAdmin();
    await call('DELETE', '/v1/account', { uid: u.uid, email: u.email, deviceId: u.deviceId, body: { confirm: true } });
    const id = (await q<{ id: string }>(`SELECT id FROM users`))[0]!.id;
    const r = await api('GET', `/v1/admin/lookup?userId=${id}`);
    expect(r.body.user).toMatchObject({ status: 'deleted' });
    expect(r.body.dataRequests).toEqual([expect.objectContaining({ kind: 'delete', status: 'received' })]);
  });
});
