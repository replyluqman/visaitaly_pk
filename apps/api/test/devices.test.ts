import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { as, call, login, newUser } from './helpers/app.js';
import { closePool, resetDb, seedLegal } from './helpers/db.js';

beforeEach(async () => {
  await resetDb();
  await seedLegal();
});
afterAll(closePool);

describe('devices', () => {
  it('lists only own active devices, flags the current one', async () => {
    const a = newUser();
    const a2 = { ...a, deviceId: randomUUID() };
    const b = newUser();
    await login(a);
    await login(a2);
    await login(b);
    const r = await as(a)('GET', '/v1/devices');
    expect(r.status).toBe(200);
    expect(r.body.devices).toHaveLength(2);
    expect(r.body.devices.filter((d: any) => d.isCurrent).map((d: any) => d.deviceId)).toEqual([a.deviceId]);
    expect(r.body.devices.map((d: any) => d.deviceId)).not.toContain(b.deviceId);
  });

  it('remote sign-out: 204, target gets DEVICE_SIGNED_OUT, second attempt 404', async () => {
    const a = newUser();
    const a2 = { ...a, deviceId: randomUUID() };
    await login(a);
    await login(a2);
    const del = await as(a)('DELETE', `/v1/devices/${a2.deviceId}`);
    expect(del.status).toBe(204);
    const me = await as(a2)('GET', '/v1/me');
    expect(me.body.error.code).toBe('DEVICE_SIGNED_OUT');
    expect((await as(a)('DELETE', `/v1/devices/${a2.deviceId}`)).status).toBe(404);
  });

  it("cross-user: B cannot sign out A's device — 404, and A is unaffected", async () => {
    const a = newUser();
    const b = newUser();
    await login(a);
    await login(b);
    const r = await as(b)('DELETE', `/v1/devices/${a.deviceId}`);
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('NOT_FOUND');
    expect((await as(a)('GET', '/v1/me')).status).toBe(200);
  });

  it('422 on a non-uuid param; 401 unauthenticated', async () => {
    const a = newUser();
    await login(a);
    expect((await as(a)('DELETE', '/v1/devices/xyz')).status).toBe(422);
    expect((await call('GET', '/v1/devices')).status).toBe(401);
  });

  it('a signed-out device can log back in', async () => {
    const a = newUser();
    await login(a);
    await as(a)('DELETE', `/v1/devices/${a.deviceId}`);
    expect((await login(a)).status).toBe(200);
    expect((await as(a)('GET', '/v1/me')).status).toBe(200);
  });
});
