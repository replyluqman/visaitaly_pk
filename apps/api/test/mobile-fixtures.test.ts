import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { as, call, login, newUser } from './helpers/app.js';
import { closePool, resetDb, seedCatalogue, seedLegal } from './helpers/db.js';

/**
 * Golden JSON for the Flutter contract tests (apps/mobile/test/contract). These are REAL responses from the
 * handlers, not hand-written samples — if a response shape changes, regenerate and the Dart decode test shows
 * what broke:
 *
 *   MOBILE_FIXTURES_DIR=../mobile/test/fixtures pnpm test test/mobile-fixtures
 *
 * Without the variable the flows still run (the assertions below keep the exporter honest).
 */
const dir = process.env.MOBILE_FIXTURES_DIR;
const out = (name: string, body: unknown) => {
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.json`), JSON.stringify(body, null, 2) + '\n');
};

beforeEach(resetDb);
afterAll(closePool);

describe('mobile contract fixtures', () => {
  it('captures the onboarding journey end to end', async () => {
    await seedCatalogue();
    const { disclaimerId } = await seedLegal();
    const u = newUser();

    const reg = await login(u, { osVersion: 'Android 14', model: 'Pixel' });
    expect(reg.status).toBe(201);
    out('auth_session_new_user', reg.body);

    const me0 = await as(u)('GET', '/v1/me');
    out('me_disclaimer_pending', me0.body);

    const cur = await as(u)('GET', '/v1/legal/current');
    out('legal_current', cur.body);
    const doc = await as(u)('GET', '/v1/legal/current/disclaimer');
    out('legal_document', doc.body);

    const acc = await as(u)('POST', '/v1/legal/accept', { versionIds: [disclaimerId], appVersion: '1.0.0' });
    expect(acc.status).toBe(200);

    out('relationships', (await as(u)('GET', '/v1/reference/relationships')).body);

    const cnt = await as(u)('PATCH', '/v1/onboarding/applicant-count', { declaredApplicantCount: 1 });
    out('applicant_count', cnt.body);
    out('me_applicants_pending', (await as(u)('GET', '/v1/me')).body);

    const bad = await as(u)('POST', '/v1/applicants', { displayName: 'Ali', relationshipCode: 'son', currentLocation: 'pakistan' });
    expect(bad.status).toBe(422);
    out('error_validation_failed', bad.body);

    const created = await as(u)('POST', '/v1/applicants', { displayName: 'Ayesha', relationshipCode: 'wife', currentLocation: 'pakistan' });
    expect(created.status).toBe(201);
    out('applicant_created_stage_pending', created.body);
    out('me_stage_pending', (await as(u)('GET', '/v1/me')).body);

    const id = created.body.applicant.id;
    await as(u)('PATCH', `/v1/applicants/${id}`, { nullaOstaStatus: 'received', nullaOstaIssueDate: '2026-08-01' });
    const staged = await as(u)('PATCH', `/v1/applicants/${id}/stage`, { currentStage: 'nulla_osta' });
    expect(staged.body.onboardingState).toBe('complete');
    out('applicant_staged_complete', staged.body);
    out('applicants_list', (await as(u)('GET', '/v1/applicants')).body);
    out('me_complete', (await as(u)('GET', '/v1/me')).body);
  });

  it('captures the session-terminal and auth error bodies', async () => {
    await seedLegal();
    const noToken = await call('GET', '/v1/me');
    expect(noToken.status).toBe(401);
    out('error_unauthenticated', noToken.body);

    // One user, three devices: the third login evicts the oldest (PRD §2, max 2 devices).
    const u = newUser();
    const d1 = { ...u, deviceId: '11111111-1111-4111-8111-111111111111' };
    const d2 = { ...u, deviceId: '22222222-2222-4222-8222-222222222222' };
    const d3 = { ...u, deviceId: '33333333-3333-4333-8333-333333333333' };
    await login(d1);
    await login(d2);
    const third = await login(d3);
    expect(third.body.session.evictedDeviceIds).toEqual([d1.deviceId]);
    out('auth_session_evicted_device', third.body);
    const evicted = await as(d1)('GET', '/v1/me');
    expect(evicted.body.error.code).toBe('DEVICE_EVICTED');
    out('error_device_evicted', evicted.body);
  });
});
