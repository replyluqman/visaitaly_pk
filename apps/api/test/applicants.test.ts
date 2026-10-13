import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { as, call, login, newUser, type TestUser } from './helpers/app.js';
import { closePool, q, resetDb, seedLegal } from './helpers/db.js';

beforeEach(resetDb);
afterAll(closePool);

/** A user who has passed the disclaimer gate. */
async function onboarded(): Promise<TestUser> {
  const { disclaimerId } = (await q(`SELECT id FROM legal_versions WHERE is_current`))[0]
    ? { disclaimerId: (await q<{ id: string }>(`SELECT id FROM legal_versions WHERE is_current`))[0]!.id }
    : await seedLegal();
  const u = newUser();
  await login(u);
  await as(u)('POST', '/v1/legal/accept', { versionIds: [disclaimerId] });
  return u;
}

const wife = { displayName: 'Ayesha', relationshipCode: 'wife', currentLocation: 'pakistan' };
const son = { displayName: 'Ali', relationshipCode: 'son', currentLocation: 'pakistan', dateOfBirth: '2015-03-02' };

describe('onboarding state machine', () => {
  it('disclaimer_pending blocks applicant-count and create with LEGAL_ACCEPTANCE_REQUIRED', async () => {
    await seedLegal();
    const u = newUser();
    await login(u);
    const c = await as(u)('PATCH', '/v1/onboarding/applicant-count', { declaredApplicantCount: 2 });
    expect(c.status).toBe(403);
    expect(c.body.error.code).toBe('LEGAL_ACCEPTANCE_REQUIRED');
    const a = await as(u)('POST', '/v1/applicants', wife);
    expect(a.body.error.code).toBe('LEGAL_ACCEPTANCE_REQUIRED');
  });

  it('full path: applicants_pending → stage_pending → complete', async () => {
    await seedLegal();
    const u = await onboarded();
    const cnt = await as(u)('PATCH', '/v1/onboarding/applicant-count', { declaredApplicantCount: 2 });
    expect(cnt.body).toEqual({ declaredApplicantCount: 2, onboardingState: 'applicants_pending' });

    const a1 = await as(u)('POST', '/v1/applicants', wife);
    expect(a1.status).toBe(201);
    expect(a1.body.onboardingState).toBe('applicants_pending'); // 1 < 2 declared
    const a2 = await as(u)('POST', '/v1/applicants', son);
    expect(a2.body.onboardingState).toBe('stage_pending'); // no stages yet

    const s1 = await as(u)('PATCH', `/v1/applicants/${a1.body.applicant.id}/stage`, { currentStage: 'eligibility' });
    expect(s1.body.onboardingState).toBe('stage_pending');
    const s2 = await as(u)('PATCH', `/v1/applicants/${a2.body.applicant.id}/stage`, { currentStage: 'documents' });
    expect(s2.body.onboardingState).toBe('complete');
  });

  it('current_stage is NULL until Screen 7 runs; me.awaitingStage reflects it', async () => {
    await seedLegal();
    const u = await onboarded();
    const a = await as(u)('POST', '/v1/applicants', wife);
    expect(a.body.applicant.currentStage).toBeNull();
    expect(a.body.applicant.stageUpdatedAt).toBeNull();
    expect((await as(u)('GET', '/v1/me')).body.applicants).toMatchObject({ total: 1, awaitingStage: 1 });
    expect(await q(`SELECT 1 FROM applicant_stage_events`)).toHaveLength(0);
  });

  it('complete never regresses when another applicant is added', async () => {
    await seedLegal();
    const u = await onboarded();
    const a = await as(u)('POST', '/v1/applicants', { ...wife, currentStage: 'nulla_osta' });
    expect(a.body.onboardingState).toBe('complete');
    const b = await as(u)('POST', '/v1/applicants', { ...son, currentStage: 'documents' });
    expect(b.body.onboardingState).toBe('complete');
    await as(u)('PATCH', '/v1/onboarding/applicant-count', { declaredApplicantCount: 9 });
    expect((await as(u)('GET', '/v1/me')).body.user.onboardingState).toBe('complete');
  });

  it('after complete, creating without a stage is ONBOARDING_STEP_INVALID (409)', async () => {
    await seedLegal();
    const u = await onboarded();
    await as(u)('POST', '/v1/applicants', { ...wife, currentStage: 'nulla_osta' });
    const r = await as(u)('POST', '/v1/applicants', son);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('ONBOARDING_STEP_INVALID');
  });

  it('applicant-count validation: 0, 100, non-integer', async () => {
    await seedLegal();
    const u = await onboarded();
    for (const n of [0, 100, 1.5, '2']) {
      expect((await as(u)('PATCH', '/v1/onboarding/applicant-count', { declaredApplicantCount: n })).status).toBe(422);
    }
  });
});

describe('create / read / patch', () => {
  it('relationship_category is derived server-side; a client-sent value is ignored', async () => {
    await seedLegal();
    const u = await onboarded();
    const r = await as(u)('POST', '/v1/applicants', { ...wife, relationshipCategory: 'parent' });
    expect(r.status).toBe(201);
    expect(r.body.applicant.relationshipCategory).toBe('spouse');
    const [row] = await q<{ relationship_category: string }>(`SELECT relationship_category FROM applicants`);
    expect(row!.relationship_category).toBe('spouse');
  });

  it('validation: missing name, bad enum, future DOB, bad date format, over-long name', async () => {
    await seedLegal();
    const u = await onboarded();
    const bad = [
      { ...wife, displayName: '' },
      { ...wife, displayName: 'x'.repeat(81) },
      { ...wife, currentLocation: 'mars' },
      { ...son, dateOfBirth: '2999-01-01' },
      { ...son, dateOfBirth: '02/03/2015' },
      { ...wife, currentStage: 'nope' },
    ];
    for (const b of bad) expect((await as(u)('POST', '/v1/applicants', b)).status).toBe(422);
  });

  it('unknown relationship → 422; DOB required for child/parent only', async () => {
    await seedLegal();
    const u = await onboarded();
    const unk = await as(u)('POST', '/v1/applicants', { ...wife, relationshipCode: 'cousin' });
    expect(unk.status).toBe(422);
    expect(unk.body.error.details.relationshipCode).toBeDefined();
    const noDob = await as(u)('POST', '/v1/applicants', { ...son, dateOfBirth: undefined });
    expect(noDob.status).toBe(422);
    expect(noDob.body.error.details.dateOfBirth).toBeDefined();
    expect((await as(u)('POST', '/v1/applicants', wife)).status).toBe(201);
  });

  it('dates round-trip as text with no day shift', async () => {
    await seedLegal();
    const u = await onboarded();
    const r = await as(u)('POST', '/v1/applicants', { ...son, nullaOstaIssueDate: '2026-01-31' });
    expect(r.body.applicant.dateOfBirth).toBe('2015-03-02');
    expect(r.body.applicant.nullaOsta.issueDate).toBe('2026-01-31');
    const got = await as(u)('GET', `/v1/applicants/${r.body.applicant.id}`);
    expect(got.body.dateOfBirth).toBe('2015-03-02');
  });

  it('nulla osta expiry derives from app_config.validity_months; explicit expiry wins', async () => {
    await seedLegal();
    const u = await onboarded();
    const d = await as(u)('POST', '/v1/applicants', { ...wife, nullaOstaIssueDate: '2026-01-31' });
    expect(d.body.applicant.nullaOsta.expiryDate).toBe('2026-07-31');
    const e = await as(u)('POST', '/v1/applicants', {
      ...wife, displayName: 'B', nullaOstaIssueDate: '2026-01-31', nullaOstaExpiryDate: '2027-01-01',
    });
    expect(e.body.applicant.nullaOsta.expiryDate).toBe('2027-01-01');
    await q(`UPDATE app_config SET value = jsonb_set(value,'{validity_months}','3') WHERE key='nulla_osta'`);
    const f = await as(u)('POST', '/v1/applicants', { ...wife, displayName: 'C', nullaOstaIssueDate: '2026-01-31' });
    expect(f.body.applicant.nullaOsta.expiryDate).toBe('2026-04-30');
    await q(`UPDATE app_config SET value = jsonb_set(value,'{validity_months}','6') WHERE key='nulla_osta'`);
  });

  it('applicant limit comes from app_config → APPLICANT_LIMIT_REACHED 409', async () => {
    await seedLegal();
    const u = await onboarded();
    await q(`UPDATE app_config SET value = jsonb_set(value,'{max_applicants}','2') WHERE key='onboarding'`);
    try {
      await as(u)('POST', '/v1/applicants', wife);
      await as(u)('POST', '/v1/applicants', { ...wife, displayName: 'B' });
      const r = await as(u)('POST', '/v1/applicants', { ...wife, displayName: 'C' });
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe('APPLICANT_LIMIT_REACHED');
      expect((await as(u)('GET', '/v1/applicants')).body.maxApplicants).toBe(2);
    } finally {
      await q(`UPDATE app_config SET value = jsonb_set(value,'{max_applicants}','10') WHERE key='onboarding'`);
    }
  });

  it('list shape + only own applicants, excludes soft-deleted', async () => {
    await seedLegal();
    const u = await onboarded();
    const a = await as(u)('POST', '/v1/applicants', wife);
    await as(u)('POST', '/v1/applicants', { ...wife, displayName: 'B' });
    await as(u)('DELETE', `/v1/applicants/${a.body.applicant.id}`);
    const list = await as(u)('GET', '/v1/applicants');
    expect(list.body.applicants).toHaveLength(1);
    expect(list.body.applicants[0]).toMatchObject({
      displayName: 'B', relationshipLabel: 'Wife', relationshipCategory: 'spouse',
      access: { level: 'free', canWrite: true },
    });
  });

  it('patch: profile fields persist; empty body 422; stage via PATCH rejected', async () => {
    await seedLegal();
    const u = await onboarded();
    const a = (await as(u)('POST', '/v1/applicants', { ...wife, currentStage: 'eligibility' })).body.applicant;
    const p = await as(u)('PATCH', `/v1/applicants/${a.id}`, { displayName: 'Renamed', currentLocation: 'italy' });
    expect(p.status).toBe(200);
    expect(p.body).toMatchObject({ displayName: 'Renamed', currentLocation: 'italy' });
    expect((await as(u)('GET', `/v1/applicants/${a.id}`)).body.displayName).toBe('Renamed');
    expect((await as(u)('PATCH', `/v1/applicants/${a.id}`, {})).status).toBe(422);
    const st = await as(u)('PATCH', `/v1/applicants/${a.id}`, { currentStage: 'documents' });
    expect(st.status).toBe(422);
  });

  it('patch relationship across categories re-derives category and resets case_generated_at', async () => {
    await seedLegal();
    const u = await onboarded();
    const a = (await as(u)('POST', '/v1/applicants', { ...wife, currentStage: 'eligibility' })).body.applicant;
    await q(`UPDATE applicants SET case_generated_at = now()`);
    const p = await as(u)('PATCH', `/v1/applicants/${a.id}`, { relationshipCode: 'mother', dateOfBirth: '1960-01-01' });
    expect(p.body.relationshipCategory).toBe('parent');
    expect(p.body.caseGeneratedAt).toBeNull();
    const same = await as(u)('PATCH', `/v1/applicants/${a.id}`, { relationshipCode: 'father', dateOfBirth: '1960-01-01' });
    expect(same.body.relationshipCategory).toBe('parent');
  });
});

describe('stage', () => {
  it('records an event per move, allows backward moves, no-op when unchanged', async () => {
    await seedLegal();
    const u = await onboarded();
    const a = (await as(u)('POST', '/v1/applicants', wife)).body.applicant;
    await as(u)('PATCH', `/v1/applicants/${a.id}/stage`, { currentStage: 'documents' });
    await as(u)('PATCH', `/v1/applicants/${a.id}/stage`, { currentStage: 'eligibility' });
    await as(u)('PATCH', `/v1/applicants/${a.id}/stage`, { currentStage: 'eligibility' });
    const ev = await q<{ from_stage: string | null; to_stage: string }>(
      `SELECT from_stage, to_stage FROM applicant_stage_events ORDER BY created_at, id`,
    );
    expect(ev.map((e) => [e.from_stage, e.to_stage])).toEqual([
      [null, 'documents'],
      ['documents', 'eligibility'],
    ]);
  });

  it('422 on an invalid stage; Screen 7 maps all 8 canonical stages', async () => {
    await seedLegal();
    const u = await onboarded();
    const a = (await as(u)('POST', '/v1/applicants', wife)).body.applicant;
    expect((await as(u)('PATCH', `/v1/applicants/${a.id}/stage`, { currentStage: 'x' })).status).toBe(422);
    for (const s of ['eligibility','nulla_osta','documents','translation','appointment','application','processing','decision']) {
      expect((await as(u)('PATCH', `/v1/applicants/${a.id}/stage`, { currentStage: s })).status).toBe(200);
    }
  });

  it('stage write is atomic with case generation (invariant 10): a failure rolls both back', async () => {
    await seedLegal();
    const u = await onboarded();
    const a = (await as(u)('POST', '/v1/applicants', wife)).body.applicant;
    // Force the event insert to fail inside the same transaction.
    await q(`ALTER TABLE applicant_stage_events ADD CONSTRAINT boom_chk CHECK (to_stage <> 'decision')`);
    try {
      const r = await as(u)('PATCH', `/v1/applicants/${a.id}/stage`, { currentStage: 'decision' });
      expect(r.status).toBe(500);
      expect(r.body.error.code).toBe('INTERNAL');
      const [row] = await q<{ current_stage: string | null }>(`SELECT current_stage FROM applicants`);
      expect(row!.current_stage).toBeNull();
    } finally {
      await q(`ALTER TABLE applicant_stage_events DROP CONSTRAINT boom_chk`);
    }
  });
});

describe('access levels (PRD §7)', () => {
  const cases: Array<[string, string, string | null, string | null, boolean]> = [
    ['free', 'none', null, null, true],
    ['premium', 'active', "now() + interval '30 days'", null, true],
    ['premium open-ended', 'active', null, null, true],
    ['grace_read_only', 'expired_pending_confirmation', "now() - interval '1 day'", "now() + interval '5 days'", false],
    ['expired (grace over)', 'expired_pending_confirmation', "now() - interval '9 days'", "now() - interval '1 day'", false],
    ['expired status', 'expired', null, null, false],
    ['active but lapsed (sweep not run)', 'active', "now() - interval '1 day'", null, false],
  ];

  it.each(cases)('%s → canWrite=%s', async (_n, status, until, grace, canWrite) => {
    await seedLegal();
    const u = await onboarded();
    const a = (await as(u)('POST', '/v1/applicants', { ...wife, currentStage: 'eligibility' })).body.applicant;
    await q(
      `UPDATE applicants SET premium_status=$1, access_until=${until ?? 'NULL'}, grace_until=${grace ?? 'NULL'}`,
      [status],
    );
    const patch = await as(u)('PATCH', `/v1/applicants/${a.id}`, { displayName: 'X' });
    const stage = await as(u)('PATCH', `/v1/applicants/${a.id}/stage`, { currentStage: 'documents' });
    const get = await as(u)('GET', `/v1/applicants/${a.id}`);
    expect(get.status).toBe(200); // reads always allowed
    expect(get.body.access.canWrite).toBe(canWrite);
    if (canWrite) {
      expect(patch.status).toBe(200);
      expect(stage.status).toBe(200);
    } else {
      expect(patch.status).toBe(403);
      expect(patch.body.error.code).toBe('APPLICANT_READ_ONLY');
      expect(stage.body.error.code).toBe('APPLICANT_READ_ONLY');
      const [row] = await q<{ display_name: string; current_stage: string }>(`SELECT display_name, current_stage FROM applicants`);
      expect(row).toEqual({ display_name: 'Ayesha', current_stage: 'eligibility' });
    }
  });

  it('/me buckets entitlement against now()', async () => {
    await seedLegal();
    const u = await onboarded();
    const a = (await as(u)('POST', '/v1/applicants', wife)).body.applicant;
    const b = (await as(u)('POST', '/v1/applicants', { ...wife, displayName: 'B' })).body.applicant;
    const c = (await as(u)('POST', '/v1/applicants', { ...wife, displayName: 'C' })).body.applicant;
    await q(`UPDATE applicants SET premium_status='active', access_until=now()+interval '9 days' WHERE id=$1`, [a.id]);
    await q(`UPDATE applicants SET premium_status='expired_pending_confirmation', grace_until=now()+interval '2 days' WHERE id=$1`, [b.id]);
    await q(`UPDATE applicants SET premium_status='active', access_until=now()-interval '1 day' WHERE id=$1`, [c.id]);
    const me = (await as(u)('GET', '/v1/me')).body.entitlement;
    expect(me).toEqual({ premiumApplicantIds: [a.id], graceApplicantIds: [b.id], hasAnyPremium: true });
  });

  it('delete: paid applicants cannot be self-deleted (409 CONFLICT), free can, and state recomputes', async () => {
    await seedLegal();
    const u = await onboarded();
    const a = (await as(u)('POST', '/v1/applicants', { ...wife, currentStage: 'eligibility' })).body.applicant;
    const b = (await as(u)('POST', '/v1/applicants', { ...wife, displayName: 'B', currentStage: 'eligibility' })).body.applicant;
    await q(`UPDATE applicants SET premium_status='active' WHERE id=$1`, [a.id]);
    const paid = await as(u)('DELETE', `/v1/applicants/${a.id}`);
    expect(paid.status).toBe(409);
    expect(paid.body.error.code).toBe('CONFLICT');
    const free = await as(u)('DELETE', `/v1/applicants/${b.id}`);
    expect(free.status).toBe(200);
    expect((await as(u)('GET', `/v1/applicants/${b.id}`)).status).toBe(404);
    const [row] = await q<{ status: string; deleted_at: string | null }>(`SELECT status, deleted_at FROM applicants WHERE id=$1`, [b.id]);
    expect(row!.status).toBe('deleted');
    expect(row!.deleted_at).not.toBeNull();
  });
});

describe('ownership — cross-user 404 on every verb (Gate 3, mandatory)', () => {
  it("user B gets 404 (never 403) for user A's applicant on GET/PATCH/stage/DELETE, and nothing changes", async () => {
    await seedLegal();
    const a = await onboarded();
    const b = await onboarded();
    const owned = (await as(a)('POST', '/v1/applicants', { ...wife, currentStage: 'eligibility' })).body.applicant;

    const attempts = [
      await as(b)('GET', `/v1/applicants/${owned.id}`),
      await as(b)('PATCH', `/v1/applicants/${owned.id}`, { displayName: 'pwned' }),
      await as(b)('PATCH', `/v1/applicants/${owned.id}/stage`, { currentStage: 'decision' }),
      await as(b)('DELETE', `/v1/applicants/${owned.id}`),
    ];
    for (const r of attempts) {
      expect(r.status).toBe(404);
      expect(r.body.error.code).toBe('NOT_FOUND');
    }
    // Same response as a genuinely non-existent id: no existence oracle.
    const ghost = await as(b)('GET', `/v1/applicants/${randomUUID()}`);
    expect(ghost.body.error.message).toBe(attempts[0]!.body.error.message);

    const [row] = await q<{ display_name: string; current_stage: string; status: string }>(
      `SELECT display_name, current_stage, status FROM applicants WHERE id=$1`, [owned.id],
    );
    expect(row).toEqual({ display_name: 'Ayesha', current_stage: 'eligibility', status: 'active' });
    expect((await as(b)('GET', '/v1/applicants')).body.applicants).toEqual([]);
    expect((await as(a)('GET', '/v1/applicants')).body.applicants).toHaveLength(1);
  });

  it('422 for a non-uuid id; 401 without a session', async () => {
    await seedLegal();
    const u = await onboarded();
    expect((await as(u)('GET', '/v1/applicants/abc')).status).toBe(422);
    expect((await call('GET', '/v1/applicants')).status).toBe(401);
    expect((await call('POST', '/v1/applicants', { body: wife })).status).toBe(401);
  });
});

describe('reference', () => {
  it('relationships: active only, ordered, no auth → 401', async () => {
    await seedLegal();
    const u = await onboarded();
    const r = await as(u)('GET', '/v1/reference/relationships');
    expect(r.body.relationships.map((x: any) => x.code)).toEqual(['wife', 'husband', 'son', 'daughter', 'mother', 'father']);
    expect(r.body.relationships[2]).toEqual({ code: 'son', label: 'Son', category: 'child', requiresDob: true });
    await q(`UPDATE relationships SET is_active=false WHERE code='husband'`);
    const r2 = await as(u)('GET', '/v1/reference/relationships');
    await q(`UPDATE relationships SET is_active=true WHERE code='husband'`);
    expect(r2.body.relationships.map((x: any) => x.code)).not.toContain('husband');
    expect((await call('GET', '/v1/reference/relationships')).status).toBe(401);
  });
});
