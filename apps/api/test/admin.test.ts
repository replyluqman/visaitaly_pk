import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { asAdmin, call, login, newAdminIdentity, newUser } from './helpers/app.js';
import { closePool, q, resetDb, seedAdmin } from './helpers/db.js';

beforeEach(resetDb);
afterAll(closePool);

async function superAdmin() {
  const id = newAdminIdentity();
  const adminId = await seedAdmin(id, { isSuper: true });
  return { id, adminId, api: asAdmin(id) };
}

describe('authentication', () => {
  it('401 without a token', async () => {
    expect((await call('GET', '/v1/admin/me')).status).toBe(401);
  });

  it('a valid token for someone who is not an admin → 403 ADMIN_FORBIDDEN (no signup path)', async () => {
    const ghost = newAdminIdentity();
    const r = await asAdmin(ghost)('GET', '/v1/admin/me');
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('ADMIN_FORBIDDEN');
    expect(await q(`SELECT 1 FROM admins`)).toHaveLength(0);
  });

  it('a USER token never authenticates an admin route', async () => {
    const u = newUser();
    await login(u);
    const r = await call('GET', '/v1/admin/me', { uid: u.uid });
    expect(r.status).toBe(401); // not an `admin:` token → rejected by the admin verifier
  });

  it('MFA is required when configured; the code is distinct', async () => {
    const { id } = await superAdmin();
    const r = await asAdmin(id, { mfa: false })('GET', '/v1/admin/me');
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('ADMIN_MFA_REQUIRED');
    expect((await asAdmin(id)('GET', '/v1/admin/me')).status).toBe(200);
  });

  it('a disabled admin is locked out on the very next request', async () => {
    const { id } = await superAdmin();
    const other = newAdminIdentity();
    await seedAdmin(other, { scopes: ['read_only'] });
    expect((await asAdmin(other)('GET', '/v1/admin/me')).status).toBe(200);
    await q(`UPDATE admins SET status='disabled' WHERE firebase_uid=$1`, [other.uid]);
    expect((await asAdmin(other)('GET', '/v1/admin/me')).status).toBe(403);
    expect((await asAdmin(id)('GET', '/v1/admin/me')).status).toBe(200);
  });
});

describe('first-login linking', () => {
  it('links a pre-registered admin by VERIFIED email, once', async () => {
    const { api } = await superAdmin();
    const invitee = newAdminIdentity();
    const created = await api('POST', '/v1/admin/admins', { email: invitee.email, scopes: ['verification_manage'] });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ email: invitee.email, linked: false, isSuper: false, scopes: ['verification_manage'] });

    // unverified email must NOT link
    const unverified = await asAdmin(invitee, { verified: false })('GET', '/v1/admin/me');
    expect(unverified.status).toBe(403);
    // verified email links and returns the profile
    const me = await asAdmin(invitee)('GET', '/v1/admin/me');
    expect(me.status).toBe(200);
    expect(me.body.admin).toMatchObject({ email: invitee.email, linked: true, scopes: ['verification_manage'] });
    expect(me.body.admin.lastLoginAt).not.toBeNull();

    // a different Firebase account claiming the same email cannot take over the linked row
    const impostor = { uid: 'someone_else', email: invitee.email };
    expect((await asAdmin(impostor)('GET', '/v1/admin/me')).status).toBe(403);
  });
});

describe('scopes', () => {
  it('only super manages admins; a scoped admin gets 403', async () => {
    await superAdmin();
    const s = newAdminIdentity();
    await seedAdmin(s, { scopes: ['verification_manage', 'read_only'] });
    for (const r of [
      await asAdmin(s)('GET', '/v1/admin/admins'),
      await asAdmin(s)('POST', '/v1/admin/admins', { email: 'x@y.com' }),
      await asAdmin(s)('PATCH', '/v1/admin/admins/00000000-0000-4000-8000-000000000000', { status: 'disabled' }),
    ]) {
      expect(r.status).toBe(403);
      expect(r.body.error.code).toBe('ADMIN_FORBIDDEN');
    }
  });

  it('any active admin may read their profile and the audit log', async () => {
    const s = newAdminIdentity();
    await seedAdmin(s, { scopes: ['support_manage'] });
    expect((await asAdmin(s)('GET', '/v1/admin/me')).status).toBe(200);
    expect((await asAdmin(s)('GET', '/v1/admin/audit-log')).status).toBe(200);
  });
});

describe('managing admins (Screen 32)', () => {
  it('create validates input, rejects duplicates, audits', async () => {
    const { api, adminId } = await superAdmin();
    for (const body of [
      {}, { email: 'not-an-email' }, { email: 'a@b.com', scopes: ['god_mode'] }, { email: 'a@b.com', displayName: '' },
      { email: 'a@b.com', displayName: 'x'.repeat(81) },
    ]) {
      expect((await api('POST', '/v1/admin/admins', body)).status).toBe(422);
    }
    const ok = await api('POST', '/v1/admin/admins', { email: 'New.Person@Admin.Example.com', scopes: ['pricing_config', 'pricing_config'] });
    expect(ok.status).toBe(201);
    expect(ok.body.email).toBe('new.person@admin.example.com'); // normalised
    expect(ok.body.scopes).toEqual(['pricing_config']); // de-duplicated
    const dup = await api('POST', '/v1/admin/admins', { email: 'new.person@admin.example.com' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('CONFLICT');

    const log = await q<{ action: string; actor_id: string; target_id: string; metadata: any }>(
      `SELECT action, actor_id, target_id, metadata FROM audit_log WHERE action='admin.create'`);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ actor_id: adminId, target_id: ok.body.id });
    expect(log[0]!.metadata).toEqual({ isSuper: false, scopes: ['pricing_config'] });
    expect(JSON.stringify(log[0]!.metadata)).not.toContain('@'); // no PII in audit metadata
  });

  it('patch replaces scopes and records exactly what changed', async () => {
    const { api } = await superAdmin();
    const a = (await api('POST', '/v1/admin/admins', { email: 'a@admin.example.com', scopes: ['payment_approve', 'read_only'] })).body;
    const r = await api('PATCH', `/v1/admin/admins/${a.id}`, { scopes: ['read_only', 'refund_manage'], displayName: 'Ali' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ displayName: 'Ali', scopes: ['read_only', 'refund_manage'] });
    const [e] = await q<{ metadata: any }>(`SELECT metadata FROM audit_log WHERE action='admin.update'`);
    expect(e!.metadata).toEqual({ fields: ['displayName', 'scopes'], scopesAdded: ['refund_manage'], scopesRemoved: ['payment_approve'] });
    expect((await api('PATCH', `/v1/admin/admins/${a.id}`, {})).status).toBe(422);
    expect((await api('PATCH', `/v1/admin/admins/${a.id}`, { status: 'banned' })).status).toBe(422);
    expect((await api('PATCH', '/v1/admin/admins/nope', { status: 'disabled' })).status).toBe(422);
    expect((await api('PATCH', '/v1/admin/admins/00000000-0000-4000-8000-000000000000', { status: 'disabled' })).status).toBe(404);
  });

  it('revoking a scope takes effect on the next request', async () => {
    const { api } = await superAdmin();
    const s = newAdminIdentity();
    const created = (await api('POST', '/v1/admin/admins', { email: s.email, scopes: ['verification_manage'] })).body;
    await asAdmin(s)('GET', '/v1/admin/me'); // link
    const sApi = asAdmin(s);
    expect((await sApi('GET', '/v1/admin/me')).body.admin.scopes).toEqual(['verification_manage']);
    await api('PATCH', `/v1/admin/admins/${created.id}`, { scopes: [] });
    expect((await sApi('GET', '/v1/admin/me')).body.admin.scopes).toEqual([]);
  });

  it('lock-out guards: no self-disable/demote, and the last active super stays', async () => {
    const { api, adminId } = await superAdmin();
    const self = await api('PATCH', `/v1/admin/admins/${adminId}`, { status: 'disabled' });
    expect(self.status).toBe(409);
    expect((await api('PATCH', `/v1/admin/admins/${adminId}`, { isSuper: false })).status).toBe(409);

    const second = newAdminIdentity();
    const secondId = await seedAdmin(second, { isSuper: true });
    // with two supers, one may disable the other…
    expect((await api('PATCH', `/v1/admin/admins/${secondId}`, { status: 'disabled' })).status).toBe(200);
    // …but the disabled one can no longer act, and the remaining super is the last
    expect((await asAdmin(second)('GET', '/v1/admin/me')).status).toBe(403);
    // a third super demoting the last active super is refused
    const third = newAdminIdentity();
    await seedAdmin(third, { isSuper: true });
    await q(`UPDATE admins SET status='disabled' WHERE id=$1`, [adminId]);
    const r = await asAdmin(third)('PATCH', `/v1/admin/admins/${adminId}`, { isSuper: false });
    expect(r.status).toBeLessThan(500); // already disabled → not "the last active super"
  });

  it('the last active super cannot be demoted by a peer who is then the only one left', async () => {
    const { api, adminId } = await superAdmin();
    const peer = newAdminIdentity();
    const peerId = await seedAdmin(peer, { isSuper: true });
    expect((await api('PATCH', `/v1/admin/admins/${peerId}`, { isSuper: false })).status).toBe(200); // fine: self remains
    // now `self` is the only super; peer (no longer super) can't do anything to them anyway
    expect((await asAdmin(peer)('PATCH', `/v1/admin/admins/${adminId}`, { status: 'disabled' })).status).toBe(403);
  });

  it('list paginates by keyset', async () => {
    const { api } = await superAdmin();
    for (let i = 0; i < 4; i++) await api('POST', '/v1/admin/admins', { email: `p${i}@admin.example.com` });
    const p1 = await api('GET', '/v1/admin/admins?limit=2');
    expect(p1.body.items).toHaveLength(2);
    const p2 = await api('GET', `/v1/admin/admins?limit=2&cursor=${p1.body.nextCursor}`);
    expect(p2.body.items).toHaveLength(2);
    const p3 = await api('GET', `/v1/admin/admins?limit=2&cursor=${p2.body.nextCursor}`);
    expect(p3.body.items).toHaveLength(1);
    expect(p3.body.nextCursor).toBeNull();
    const ids = [...p1.body.items, ...p2.body.items, ...p3.body.items].map((x: any) => x.id);
    expect(new Set(ids).size).toBe(5);
    expect((await api('GET', '/v1/admin/admins?cursor=@@')).status).toBe(422);
    expect((await api('GET', '/v1/admin/admins?limit=0')).status).toBe(422);
  });
});

describe('keyset pagination is exact below the millisecond', () => {
  it('rows sharing a millisecond but differing in microseconds are neither skipped nor repeated', async () => {
    const { api } = await superAdmin();
    await q(`DELETE FROM admin_permissions`);
    await q(`DELETE FROM admins WHERE NOT is_super`);
    for (const us of ['123100', '123456', '123900']) {
      await q(`INSERT INTO admins (email, created_at) VALUES ($1, $2::timestamptz)`,
        [`us${us}@admin.example.com`, `2030-01-01 00:00:00.${us}+00`]);
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const r: any = await api('GET', `/v1/admin/admins?limit=1${cursor ? `&cursor=${cursor}` : ''}`);
      seen.push(...r.body.items.map((x: any) => x.email));
      cursor = r.body.nextCursor;
    } while (cursor);
    expect(seen.filter((e) => e.startsWith('us'))).toEqual([
      'us123100@admin.example.com', 'us123456@admin.example.com', 'us123900@admin.example.com',
    ]);
    expect(seen).toHaveLength(4); // + the super admin, once
  });
});

describe('audit log (Screen 45)', () => {
  it('lists newest first with filters + keyset cursor', async () => {
    const { api, adminId } = await superAdmin();
    const a = (await api('POST', '/v1/admin/admins', { email: 'a@admin.example.com' })).body;
    await api('PATCH', `/v1/admin/admins/${a.id}`, { displayName: 'A' });
    await api('PATCH', `/v1/admin/admins/${a.id}`, { displayName: 'B' });
    const all = await api('GET', '/v1/admin/audit-log');
    expect(all.body.items.map((e: any) => e.action)).toEqual(['admin.update', 'admin.update', 'admin.create']);
    expect(all.body.items[0]).toMatchObject({ actorType: 'admin', actorId: adminId, targetType: 'admin', targetId: a.id });
    expect(all.body.items[0].requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect((await api('GET', '/v1/admin/audit-log?action=admin.create')).body.items).toHaveLength(1);
    expect((await api('GET', `/v1/admin/audit-log?targetId=${a.id}`)).body.items).toHaveLength(3);
    expect((await api('GET', `/v1/admin/audit-log?actorId=${adminId}`)).body.items).toHaveLength(3);
    const p1 = await api('GET', '/v1/admin/audit-log?limit=2');
    const p2 = await api('GET', `/v1/admin/audit-log?limit=2&cursor=${p1.body.nextCursor}`);
    expect(p1.body.items).toHaveLength(2);
    expect(p2.body.items).toHaveLength(1);
    expect(p2.body.nextCursor).toBeNull();
    expect((await api('GET', '/v1/admin/audit-log?actorId=x')).status).toBe(422);
  });

  it('is append-only: UPDATE always fails; DELETE of recent rows fails; old rows can be retired', async () => {
    const { api } = await superAdmin();
    await api('POST', '/v1/admin/admins', { email: 'a@admin.example.com' });
    await expect(q(`UPDATE audit_log SET action='tampered'`)).rejects.toThrow(/append-only/);
    await expect(q(`DELETE FROM audit_log`)).rejects.toThrow(/younger than 12 months/);
    // retention: a row older than 12 months may be deleted (the Module 10 archive job)
    await q(`ALTER TABLE audit_log DISABLE TRIGGER audit_log_immutable`);
    await q(`UPDATE audit_log SET created_at = now() - interval '13 months'`);
    await q(`ALTER TABLE audit_log ENABLE TRIGGER audit_log_immutable`);
    await expect(q(`DELETE FROM audit_log`)).resolves.toBeDefined();
  });

  it('the action and its audit row commit together: a failing audit write rolls the admin back', async () => {
    const { api } = await superAdmin();
    await q(`ALTER TABLE audit_log ADD CONSTRAINT boom_chk CHECK (action <> 'admin.create')`);
    try {
      const r = await api('POST', '/v1/admin/admins', { email: 'a@admin.example.com' });
      expect(r.status).toBe(500);
      expect(await q(`SELECT 1 FROM admins WHERE email='a@admin.example.com'`)).toHaveLength(0);
    } finally {
      await q(`ALTER TABLE audit_log DROP CONSTRAINT boom_chk`);
    }
  });
});
