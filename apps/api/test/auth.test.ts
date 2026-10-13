import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { as, call, login, newUser, rawFetch as app_fetch } from './helpers/app.js';
import { closePool, q, resetDb, seedLegal } from './helpers/db.js';

beforeEach(async () => {
  await resetDb();
  await seedLegal();
});
afterAll(closePool);

describe('POST /v1/auth/session', () => {
  it('201 on first login, 200 on repeat, shape matches RegisterSessionResponse', async () => {
    const u = newUser();
    const first = await login(u);
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({
      user: { email: u.email, onboardingState: 'disclaimer_pending' },
      entitlement: { premiumApplicantIds: [], graceApplicantIds: [], hasAnyPremium: false },
      devices: { maxActive: 2, activeCount: 1 },
      legal: { requiresAcceptance: true, pendingDocTypes: ['disclaimer'] },
      applicants: { declaredCount: null, total: 0, awaitingStage: 0 },
      session: { evictedDeviceIds: [], isNewUser: true },
    });
    const again = await login(u);
    expect(again.status).toBe(200);
    expect(again.body.session.isNewUser).toBe(false);
    expect(again.body.user.id).toBe(first.body.user.id);
    expect(again.body.devices.activeCount).toBe(1);
  });

  it('401 without a token and with a bad token', async () => {
    const body = { deviceId: randomUUID(), platform: 'android', appVersion: '1' };
    expect((await call('POST', '/v1/auth/session', { body })).status).toBe(401);
    const bad = await call('POST', '/v1/auth/session', {
      headers: { Authorization: 'Bearer garbage' },
      body,
    });
    expect(bad.status).toBe(401);
    expect(bad.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('422 with details on invalid body; malformed JSON is 422 not 500', async () => {
    const u = newUser();
    const r = await call('POST', '/v1/auth/session', {
      uid: u.uid,
      body: { deviceId: 'nope', platform: 'windows', appVersion: '' },
    });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('VALIDATION_FAILED');
    expect(Object.keys(r.body.error.details)).toEqual(
      expect.arrayContaining(['deviceId', 'platform', 'appVersion']),
    );
    const bad = await call('POST', '/v1/auth/session', { uid: u.uid, rawBody: '{not json' });
    expect(bad.status).toBe(422);
  });

  it('rejects over-long strings (DoS guard)', async () => {
    const u = newUser();
    const r = await call('POST', '/v1/auth/session', {
      uid: u.uid,
      body: { deviceId: u.deviceId, platform: 'android', appVersion: 'x'.repeat(33) },
    });
    expect(r.status).toBe(422);
  });

  it('never clobbers a display name already set, never resets onboarding_state', async () => {
    const u = newUser();
    await login(u);
    await q(`UPDATE users SET display_name='Chosen', onboarding_state='complete'`);
    const r = await login(u);
    expect(r.body.user.displayName).toBe('Chosen');
    expect(r.body.user.onboardingState).toBe('complete');
  });

  it('re-signup with the same email under a NEW firebase uid succeeds (migration 0004)', async () => {
    const a = newUser('same');
    const b = { ...newUser('other'), email: a.email };
    expect((await login(a)).status).toBe(201);
    await q(`UPDATE users SET status='deleted', deleted_at=now(), email=NULL`);
    const r = await login(b);
    expect(r.status).toBe(201);
    // And two LIVE rows with one email are now permitted.
    const c = { ...newUser('third'), email: a.email };
    expect((await login(c)).status).toBe(201);
  });

  it('refuses a deleted account and does not rewrite its PII', async () => {
    const u = newUser();
    await login(u);
    await q(`UPDATE users SET status='deleted', deleted_at=now(), email=NULL, display_name=NULL`);
    const r = await login(u);
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('USER_DELETED');
    const [row] = await q<{ email: string | null; display_name: string | null }>(
      `SELECT email, display_name FROM users`,
    );
    expect(row).toEqual({ email: null, display_name: null });
  });
});

describe('2-device rule (PRD §2)', () => {
  it('third device evicts the least-recently-used; evicted device gets DEVICE_EVICTED', async () => {
    const base = newUser();
    const d1 = base;
    const d2 = { ...base, deviceId: randomUUID() };
    const d3 = { ...base, deviceId: randomUUID() };
    await login(d1);
    await login(d2);
    const r = await login(d3);
    expect(r.body.session.evictedDeviceIds).toEqual([d1.deviceId]);
    expect(r.body.devices.activeCount).toBe(2);

    const me = await as(d1)('GET', '/v1/me');
    expect(me.status).toBe(401);
    expect(me.body.error.code).toBe('DEVICE_EVICTED');
    expect((await as(d2)('GET', '/v1/me')).status).toBe(200);
    expect((await as(d3)('GET', '/v1/me')).status).toBe(200);
  });

  it('limit comes from app_config, not code', async () => {
    await q(`UPDATE app_config SET value = jsonb_set(value,'{max_active_devices}','1') WHERE key='auth'`);
    const base = newUser();
    const d2 = { ...base, deviceId: randomUUID() };
    await login(base);
    const r = await login(d2);
    expect(r.body.session.evictedDeviceIds).toEqual([base.deviceId]);
    expect(r.body.devices.maxActive).toBe(1);
    await q(`UPDATE app_config SET value = jsonb_set(value,'{max_active_devices}','2') WHERE key='auth'`);
  });

  it('falls back to the named default when the config row is missing', async () => {
    const saved = await q(`SELECT key, value FROM app_config WHERE key='auth'`);
    await q(`DELETE FROM app_config WHERE key='auth'`);
    try {
      const base = newUser();
      await login(base);
      await login({ ...base, deviceId: randomUUID() });
      const r = await login({ ...base, deviceId: randomUUID() });
      expect(r.body.session.evictedDeviceIds).toHaveLength(1);
      expect(r.body.devices.maxActive).toBe(2);
    } finally {
      await q(`INSERT INTO app_config (key, value) VALUES ('auth', $1)`, [saved[0]!.value]);
    }
  });

  it('re-login on an evicted device reactivates it', async () => {
    const base = newUser();
    const d2 = { ...base, deviceId: randomUUID() };
    const d3 = { ...base, deviceId: randomUUID() };
    await login(base);
    await login(d2);
    await login(d3); // evicts base
    const r = await login(base); // evicts d2
    expect(r.body.session.evictedDeviceIds).toEqual([d2.deviceId]);
    expect((await as(base)('GET', '/v1/me')).status).toBe(200);
  });

  it("users' devices never count against each other", async () => {
    const a = newUser();
    const b = newUser();
    await login(a);
    await login({ ...a, deviceId: randomUUID() });
    const r = await login(b);
    expect(r.body.session.evictedDeviceIds).toEqual([]);
  });
});

describe('requireSession', () => {
  it('400 without X-Device-Id, 422 for a malformed one, 401 DEVICE_UNKNOWN for an unregistered one', async () => {
    const u = newUser();
    await login(u);
    const noDev = await call('GET', '/v1/me', { uid: u.uid });
    expect(noDev.status).toBe(400);
    expect(noDev.body.error.code).toBe('DEVICE_HEADER_MISSING');
    const bad = await call('GET', '/v1/me', { uid: u.uid, deviceId: 'not-a-uuid' });
    expect(bad.status).toBe(422);
    const unk = await call('GET', '/v1/me', { uid: u.uid, deviceId: randomUUID() });
    expect(unk.status).toBe(401);
    expect(unk.body.error.code).toBe('DEVICE_UNKNOWN');
  });

  it('401 without a token; 401 for a valid token with no account', async () => {
    expect((await call('GET', '/v1/me', { deviceId: randomUUID() })).status).toBe(401);
    const r = await call('GET', '/v1/me', { uid: 'ghost', deviceId: randomUUID() });
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('UNAUTHENTICATED');
  });

  it("another user's device id is DEVICE_UNKNOWN, not accepted", async () => {
    const a = newUser();
    const b = newUser();
    await login(a);
    await login(b);
    const r = await call('GET', '/v1/me', { uid: b.uid, deviceId: a.deviceId });
    expect(r.body.error.code).toBe('DEVICE_UNKNOWN');
  });

  it('deleted user → USER_DELETED on every route', async () => {
    const u = newUser();
    await login(u);
    await q(`UPDATE users SET status='deleted', deleted_at=now()`);
    const r = await as(u)('GET', '/v1/me');
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('USER_DELETED');
  });

  it('error bodies carry a requestId and no internals', async () => {
    const r = await call('GET', '/v1/me');
    expect(r.body.error.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(r.body)).not.toMatch(/select|stack|pg|postgres/i);
  });
});

describe('GET /v1/me', () => {
  it('touches last_seen_at for the calling device only', async () => {
    const base = newUser();
    const d2 = { ...base, deviceId: randomUUID() };
    await login(base);
    await login(d2);
    await q(`UPDATE devices SET last_seen_at = now() - interval '1 day'`);
    await as(base)('GET', '/v1/me');
    const rows = await q<{ device_id: string; fresh: boolean }>(
      `SELECT device_id, last_seen_at > now() - interval '1 minute' AS fresh FROM devices`,
    );
    expect(rows.find((r) => r.device_id === base.deviceId)!.fresh).toBe(true);
    expect(rows.find((r) => r.device_id === d2.deviceId)!.fresh).toBe(false);
  });

  it('unknown routes 404 with the error envelope', async () => {
    const r = await call('GET', '/v1/nope');
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('NOT_FOUND');
  });
});

describe('X-Request-Id', () => {
  it('is returned on success and on error, and matches the error body', async () => {
    const ok = await app_fetch('/health');
    expect(ok.headers.get('X-Request-Id')).toMatch(/^[0-9a-f-]{36}$/);
    const err = await app_fetch('/v1/me');
    expect(err.status).toBe(401);
    const body = (await err.json()) as any;
    expect(err.headers.get('X-Request-Id')).toBe(body.error.requestId);
  });
});
