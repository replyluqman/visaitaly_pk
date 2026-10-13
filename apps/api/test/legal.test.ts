import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { as, call, login, newUser } from './helpers/app.js';
import { closePool, q, resetDb, seedLegal } from './helpers/db.js';

beforeEach(resetDb);
afterAll(closePool);

describe('legal', () => {
  it('current: lists docs without bodies and flags requiresAcceptance', async () => {
    await seedLegal({ withTerms: true });
    const u = newUser();
    await login(u);
    const r = await as(u)('GET', '/v1/legal/current');
    expect(r.status).toBe(200);
    expect(r.body.requiresAcceptance).toBe(true);
    expect(r.body.documents.map((d: any) => d.docType).sort()).toEqual(['disclaimer', 'terms']);
    expect(JSON.stringify(r.body)).not.toContain('bodyMd');
  });

  it('document: full text; 404 when none published; 422 for unknown doc type', async () => {
    const u = newUser();
    await login(u);
    expect((await as(u)('GET', '/v1/legal/current/disclaimer')).status).toBe(404);
    await seedLegal();
    const r = await as(u)('GET', '/v1/legal/current/disclaimer');
    expect(r.status).toBe(200);
    expect(r.body.bodyMd).toBe('test body');
    expect((await as(u)('GET', '/v1/legal/current/bogus')).status).toBe(422);
  });

  it('locale falls back to en per document', async () => {
    await seedLegal();
    const u = newUser();
    await login(u);
    const r = await as(u)('GET', '/v1/legal/current?locale=ur');
    expect(r.body.documents[0].locale).toBe('en');
  });

  it('accept: persists, moves state to applicants_pending, is idempotent', async () => {
    const { disclaimerId } = await seedLegal();
    const u = newUser();
    await login(u);
    const r = await as(u)('POST', '/v1/legal/accept', { versionIds: [disclaimerId], appVersion: '1.0' });
    expect(r.status).toBe(200);
    expect(r.body.onboardingState).toBe('applicants_pending');
    const again = await as(u)('POST', '/v1/legal/accept', { versionIds: [disclaimerId] });
    expect(again.status).toBe(200);
    const rows = await q(`SELECT * FROM legal_acceptances`);
    expect(rows).toHaveLength(1);
    expect(rows[0]).not.toHaveProperty('ip');
    expect(rows[0]).not.toHaveProperty('ip_address');
    expect((await as(u)('GET', '/v1/legal/current')).body.requiresAcceptance).toBe(false);
  });

  it('accept: partial accept of mandatory docs is rejected 422 and writes nothing', async () => {
    const { termsId } = await seedLegal({ withTerms: true });
    const u = newUser();
    await login(u);
    const r = await as(u)('POST', '/v1/legal/accept', { versionIds: [termsId] });
    expect(r.status).toBe(422);
    expect(await q(`SELECT 1 FROM legal_acceptances`)).toHaveLength(0);
  });

  it('accept: a non-current / unknown version id is rejected and nothing is written', async () => {
    const { disclaimerId } = await seedLegal();
    const u = newUser();
    await login(u);
    const r = await as(u)('POST', '/v1/legal/accept', { versionIds: [disclaimerId, randomUUID()] });
    expect(r.status).toBe(422);
    expect(await q(`SELECT 1 FROM legal_acceptances`)).toHaveLength(0);
  });

  it('accept: validation — empty list, non-uuid, too many', async () => {
    await seedLegal();
    const u = newUser();
    await login(u);
    expect((await as(u)('POST', '/v1/legal/accept', { versionIds: [] })).status).toBe(422);
    expect((await as(u)('POST', '/v1/legal/accept', { versionIds: ['x'] })).status).toBe(422);
    expect(
      (await as(u)('POST', '/v1/legal/accept', { versionIds: Array.from({ length: 11 }, () => randomUUID()) })).status,
    ).toBe(422);
  });

  it("acceptance is per user: A accepting never satisfies B", async () => {
    const { disclaimerId } = await seedLegal();
    const a = newUser();
    const b = newUser();
    await login(a);
    await login(b);
    await as(a)('POST', '/v1/legal/accept', { versionIds: [disclaimerId] });
    const r = await as(b)('GET', '/v1/legal/current');
    expect(r.body.requiresAcceptance).toBe(true);
    expect((await as(b)('GET', '/v1/me')).body.user.onboardingState).toBe('disclaimer_pending');
  });

  it('matches on (doc_type, version): same version in another locale is already accepted', async () => {
    const { disclaimerId } = await seedLegal({ version: '1.0' });
    await q(
      `INSERT INTO legal_versions (doc_type, locale, version, title, body_md, is_current, published_at)
       VALUES ('disclaimer','ur','1.0','t','b',true,now())`,
    );
    const u = newUser();
    await login(u);
    await as(u)('POST', '/v1/legal/accept', { versionIds: [disclaimerId] });
    const r = await as(u)('GET', '/v1/legal/current?locale=ur');
    expect(r.body.documents[0].locale).toBe('ur');
    expect(r.body.documents[0].accepted).toBe(true);
    expect(r.body.requiresAcceptance).toBe(false);
  });

  it('publishing a new version forces re-acceptance; complete never regresses', async () => {
    const { disclaimerId } = await seedLegal({ version: '1.0' });
    const u = newUser();
    await login(u);
    await as(u)('POST', '/v1/legal/accept', { versionIds: [disclaimerId] });
    await q(`UPDATE users SET onboarding_state='complete'`);
    await q(`UPDATE legal_versions SET is_current=false`);
    await q(
      `INSERT INTO legal_versions (doc_type, locale, version, title, body_md, is_current, published_at)
       VALUES ('disclaimer','en','2.0','t','b',true,now())`,
    );
    const me = await as(u)('GET', '/v1/me');
    expect(me.body.legal).toEqual({ requiresAcceptance: true, pendingDocTypes: ['disclaimer'] });
    expect(me.body.user.onboardingState).toBe('complete');
  });

  it('401 unauthenticated on every route', async () => {
    for (const [m, p] of [
      ['GET', '/v1/legal/current'],
      ['GET', '/v1/legal/current/disclaimer'],
      ['POST', '/v1/legal/accept'],
    ] as const) {
      expect((await call(m, p)).status).toBe(401);
    }
  });
});
