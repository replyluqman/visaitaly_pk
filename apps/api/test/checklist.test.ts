import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { as, call, login, newUser, type TestUser } from './helpers/app.js';
import { closePool, q, resetDb, seedCatalogue, seedLegal, type Catalogue } from './helpers/db.js';

let cat: Catalogue;

beforeEach(async () => {
  await resetDb();
  await seedLegal();
  cat = await seedCatalogue();
});
afterAll(closePool);

async function onboarded(): Promise<TestUser> {
  const id = (await q<{ id: string }>(`SELECT id FROM legal_versions WHERE is_current`))[0]!.id;
  const u = newUser();
  await login(u);
  await as(u)('POST', '/v1/legal/accept', { versionIds: [id] });
  return u;
}

const wife = { displayName: 'Ayesha', relationshipCode: 'wife', currentLocation: 'pakistan' };
const son = { displayName: 'Ali', relationshipCode: 'son', currentLocation: 'pakistan', dateOfBirth: '2015-03-02' };
const mother = { displayName: 'Zubaida', relationshipCode: 'mother', currentLocation: 'pakistan', dateOfBirth: '1960-01-01' };

async function applicant(u: TestUser, body: object = wife, stage = 'eligibility', paid = false): Promise<string> {
  const r = await as(u)('POST', '/v1/applicants', { ...body, currentStage: stage });
  expect(r.status).toBe(201);
  if (paid) await premium(r.body.applicant.id);
  return r.body.applicant.id;
}
const premium = (id: string) =>
  q(`UPDATE applicants SET premium_status='active', access_until=now()+interval '30 days' WHERE id=$1`, [id]);
const codes = (items: any[]) => items.map((i) => i.requirementCode);

describe('case generation', () => {
  it('instantiates every published requirement; draft excluded; case_generated_at set', async () => {
    const u = await onboarded();
    const id = await applicant(u);
    const rows = await q(`SELECT 1 FROM applicant_requirements WHERE applicant_id=$1`, [id]);
    expect(rows).toHaveLength(10); // 10 published, draft_item excluded
    const a = await as(u)('GET', `/v1/applicants/${id}`);
    expect(a.body.caseGeneratedAt).not.toBeNull();
  });

  it('applicability by category, location, age, nulla osta status', async () => {
    const u = await onboarded();
    const spouse = await applicant(u, { ...wife, dateOfBirth: '1990-05-05' }, 'eligibility', true);
    const child = await applicant(u, son, 'eligibility', true);
    const parent = await applicant(u, mother, 'eligibility', true);
    const view = async (id: string) => {
      const r = await as(u)('GET', `/v1/applicants/${id}/checklist?limit=50`);
      return r.body.items as any[];
    };
    const app = (items: any[]) => items.filter((i) => i.status !== 'not_applicable').map((i) => i.requirementCode).sort();

    expect(app(await view(spouse))).toEqual(['adult_only', 'appointment_slot', 'nikah', 'passport', 'visa_form']);
    expect(app(await view(child))).toEqual(['appointment_slot', 'birth_cert', 'minor_only', 'passport', 'visa_form']);
    expect(app(await view(parent))).toEqual(['adult_only', 'appointment_slot', 'dependency', 'passport', 'visa_form']);
  });

  it('unknown DOB never excludes an age-bounded item', async () => {
    const u = await onboarded();
    const id = await applicant(u, wife, 'eligibility', true); // wife, no DOB
    const items = (await as(u)('GET', `/v1/applicants/${id}/checklist?limit=50`)).body.items;
    const find = (c: string) => items.find((i: any) => i.requirementCode === c);
    expect(find('adult_only').status).toBe('not_started');
    expect(find('minor_only').status).toBe('not_started');
  });

  it('non-applicable items are shown with their reason, read-only', async () => {
    const u = await onboarded();
    const id = await applicant(u, wife, 'eligibility', true);
    const items = (await as(u)('GET', `/v1/applicants/${id}/checklist?limit=50`)).body.items;
    const na = items.find((i: any) => i.requirementCode === 'dependency');
    expect(na).toMatchObject({ status: 'not_applicable', notApplicableReason: 'Not for your category.', badges: [] });
    const patch = await as(u)('PATCH', `/v1/checklist/${na.id}`, { status: 'ready' });
    expect(patch.status).toBe(409);
    expect(patch.body.error.code).toBe('CONFLICT');
  });

  it('nulla-osta-gated item appears when status flips to received, and flips back keeping progress', async () => {
    const u = await onboarded();
    const id = await applicant(u, wife, 'eligibility', true);
    const get = async () =>
      (await as(u)('GET', `/v1/applicants/${id}/checklist?limit=50`)).body.items.find((i: any) => i.requirementCode === 'after_nulla');
    expect((await get()).status).toBe('not_applicable');
    await as(u)('PATCH', `/v1/applicants/${id}`, { nullaOstaStatus: 'received' });
    const item = await get();
    expect(item.status).toBe('not_started');
    await as(u)('PATCH', `/v1/checklist/${item.id}`, { status: 'ready' });
    await as(u)('PATCH', `/v1/applicants/${id}`, { nullaOstaStatus: 'in_process' });
    expect((await get()).status).toBe('not_applicable');
    await as(u)('PATCH', `/v1/applicants/${id}`, { nullaOstaStatus: 'received' });
    expect((await get()).status).toBe('ready'); // progress preserved across the flip
  });

  it('is idempotent: re-setting or changing stage never duplicates rows or resets progress', async () => {
    const u = await onboarded();
    const id = await applicant(u, wife, 'eligibility', true);
    const first = (await as(u)('GET', `/v1/applicants/${id}/checklist`)).body.items[0];
    await as(u)('PATCH', `/v1/checklist/${first.id}`, { status: 'in_progress' });
    await as(u)('PATCH', `/v1/applicants/${id}/stage`, { currentStage: 'documents' });
    await as(u)('PATCH', `/v1/applicants/${id}/stage`, { currentStage: 'eligibility' });
    expect(await q(`SELECT 1 FROM applicant_requirements WHERE applicant_id=$1`, [id])).toHaveLength(10);
    expect((await as(u)('GET', `/v1/checklist/${first.id}`)).body.status).toBe('in_progress');
  });

  it('generation is atomic with the stage write (invariant 10)', async () => {
    const u = await onboarded();
    const r0 = await as(u)('POST', '/v1/applicants', wife);
    const id = r0.body.applicant.id;
    await q(`ALTER TABLE applicant_requirements ADD CONSTRAINT boom_chk CHECK (false)`);
    try {
      const r = await as(u)('PATCH', `/v1/applicants/${id}/stage`, { currentStage: 'documents' });
      expect(r.status).toBe(500);
      const [row] = await q<{ current_stage: string | null; case_generated_at: string | null }>(
        `SELECT current_stage, case_generated_at FROM applicants`,
      );
      expect(row).toEqual({ current_stage: null, case_generated_at: null });
      expect(await q(`SELECT 1 FROM applicant_stage_events`)).toHaveLength(0);
    } finally {
      await q(`ALTER TABLE applicant_requirements DROP CONSTRAINT boom_chk`);
    }
  });
});

describe('free preview (PRD §8)', () => {
  it('free user sees the first 3 applicable items + lockedCount; N/A hidden', async () => {
    const u = await onboarded();
    const id = await applicant(u);
    const r = await as(u)('GET', `/v1/applicants/${id}/checklist`);
    expect(r.status).toBe(200);
    expect(codes(r.body.items)).toEqual(['passport', 'nikah', 'adult_only']);
    expect(r.body.items.every((i: any) => i.status !== 'not_applicable')).toBe(true);
    expect(r.body.lockedCount).toBe(3); // 6 applicable (DOB unknown keeps both age items) − 3
    expect(r.body.nextCursor).toBeNull();
  });

  it('cap is config-driven', async () => {
    const u = await onboarded();
    const id = await applicant(u);
    await q(`UPDATE app_config SET value='{"free_preview_items": 1}' WHERE key='checklist'`);
    try {
      const r = await as(u)('GET', `/v1/applicants/${id}/checklist`);
      expect(codes(r.body.items)).toEqual(['passport']);
      expect(r.body.lockedCount).toBe(5);
    } finally {
      await q(`UPDATE app_config SET value='{"free_preview_items": 3}' WHERE key='checklist'`);
    }
  });

  it('filters cannot widen the preview', async () => {
    const u = await onboarded();
    const id = await applicant(u);
    const r = await as(u)('GET', `/v1/applicants/${id}/checklist?status=not_started&limit=50`);
    expect(r.body.items).toHaveLength(3);
    const na = await as(u)('GET', `/v1/applicants/${id}/checklist?status=not_applicable`);
    expect(na.body.items).toEqual([]);
  });

  it('locked items: detail → 402, patch → 402 and unchanged; visible items stay writable', async () => {
    const u = await onboarded();
    const id = await applicant(u);
    const locked = (await q<{ id: string }>(
      `SELECT ar.id FROM applicant_requirements ar JOIN requirements r ON r.id = ar.requirement_id
        WHERE ar.applicant_id=$1 AND r.code='appointment_slot'`, [id]))[0]!.id;
    const d = await as(u)('GET', `/v1/checklist/${locked}`);
    expect(d.status).toBe(402);
    expect(d.body.error.code).toBe('PREMIUM_REQUIRED');
    const p = await as(u)('PATCH', `/v1/checklist/${locked}`, { status: 'ready' });
    expect(p.status).toBe(402);
    expect((await q<{ status: string }>(`SELECT status FROM applicant_requirements WHERE id=$1`, [locked]))[0]!.status).toBe('not_started');
    const visible = (await as(u)('GET', `/v1/applicants/${id}/checklist`)).body.items[0];
    expect((await as(u)('PATCH', `/v1/checklist/${visible.id}`, { status: 'ready' })).status).toBe(200);
  });

  it('premium sees everything incl. N/A, lockedCount 0', async () => {
    const u = await onboarded();
    const id = await applicant(u, wife, 'eligibility', true);
    const r = await as(u)('GET', `/v1/applicants/${id}/checklist?limit=50`);
    expect(r.body.items).toHaveLength(10);
    expect(r.body.lockedCount).toBe(0);
    expect(r.body.items.filter((i: any) => i.status === 'not_applicable')).toHaveLength(4);
  });
});

describe('list: filters, badges, order, pagination, delta', () => {
  it('journey order; blocking badge clears when ready; filters', async () => {
    const u = await onboarded();
    const id = await applicant(u, wife, 'eligibility', true);
    const r = await as(u)('GET', `/v1/applicants/${id}/checklist?limit=50`);
    expect(codes(r.body.items)).toEqual([
      'passport', 'nikah', 'birth_cert', 'dependency', 'italy_only', 'adult_only', 'minor_only',
      'after_nulla', 'appointment_slot', 'visa_form',
    ]);
    const passport = r.body.items[0];
    expect(passport).toMatchObject({ badges: ['blocking'], stage: 'eligibility', requirementVersion: 1, documentCount: 0 });
    expect(passport.lastVerifiedAt).not.toBeNull();

    const blocking = await as(u)('GET', `/v1/applicants/${id}/checklist?blocking=true&limit=50`);
    expect(codes(blocking.body.items)).toEqual(['passport', 'nikah', 'appointment_slot']);
    await as(u)('PATCH', `/v1/checklist/${passport.id}`, { status: 'ready' });
    const after = await as(u)('GET', `/v1/checklist/${passport.id}`);
    expect(after.body.badges).toEqual([]);
    const tr = await as(u)('GET', `/v1/applicants/${id}/checklist?translation=true&limit=50`);
    expect(codes(tr.body.items)).toEqual(['nikah', 'birth_cert']);
    const ap = await as(u)('GET', `/v1/applicants/${id}/checklist?apostille=true&limit=50`);
    expect(codes(ap.body.items)).toEqual(['nikah']);
    const ready = await as(u)('GET', `/v1/applicants/${id}/checklist?status=ready`);
    expect(codes(ready.body.items)).toEqual(['passport']);
  });

  it('keyset pagination walks the whole list exactly once', async () => {
    const u = await onboarded();
    const id = await applicant(u, wife, 'eligibility', true);
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const url: string = `/v1/applicants/${id}/checklist?limit=3${cursor ? `&cursor=${cursor}` : ''}`;
      const r = await as(u)('GET', url);
      seen.push(...codes(r.body.items));
      cursor = r.body.nextCursor;
      pages++;
    } while (cursor);
    expect(pages).toBe(4);
    expect(seen).toHaveLength(10);
    expect(new Set(seen).size).toBe(10);
  });

  it('bad query / cursor → 422; limit > 50 → 422', async () => {
    const u = await onboarded();
    const id = await applicant(u);
    for (const qs of ['cursor=@@@', 'limit=0', 'limit=51', 'status=bogus', 'since=yesterday', 'blocking=maybe']) {
      expect((await as(u)('GET', `/v1/applicants/${id}/checklist?${qs}`)).status).toBe(422);
    }
  });

  it('delta sync: since returns only changed rows, incl. requirement edits (version bumps)', async () => {
    const u = await onboarded();
    const id = await applicant(u, wife, 'eligibility', true);
    const first = await as(u)('GET', `/v1/applicants/${id}/checklist?limit=50`);
    const since = encodeURIComponent(first.body.syncedAt);
    expect((await as(u)('GET', `/v1/applicants/${id}/checklist?since=${since}&limit=50`)).body.items).toEqual([]);

    await as(u)('PATCH', `/v1/checklist/${first.body.items[0].id}`, { status: 'in_progress' });
    await q(`UPDATE requirements SET title = '{"en":"Passport (updated)"}' WHERE code='visa_form'`);
    const d = await as(u)('GET', `/v1/applicants/${id}/checklist?since=${since}&limit=50`);
    expect(codes(d.body.items)).toEqual(['passport', 'visa_form']);
    expect(d.body.items[1]).toMatchObject({ title: 'Passport (updated)', requirementVersion: 2 });
  });

  it('source_under_review badge follows an open source flag', async () => {
    const u = await onboarded();
    const id = await applicant(u);
    await q(`INSERT INTO source_flags (source_id, new_hash) VALUES ($1,'abc')`, [cat.sourceId]);
    const r = await as(u)('GET', `/v1/applicants/${id}/checklist`);
    expect(r.body.items[0].badges).toEqual(['blocking', 'source_under_review']);
    await q(`UPDATE source_flags SET status='resolved', resolved_at=now()`);
    expect((await as(u)('GET', `/v1/applicants/${id}/checklist`)).body.items[0].badges).toEqual(['blocking']);
  });

  it('detail: purpose, source block, canWrite', async () => {
    const u = await onboarded();
    const id = await applicant(u);
    const item = (await as(u)('GET', `/v1/applicants/${id}/checklist`)).body.items[0];
    const d = await as(u)('GET', `/v1/checklist/${item.id}`);
    expect(d.status).toBe(200);
    expect(d.body).toMatchObject({
      purpose: 'why', canWrite: true, documents: [], staleAfterDays: 30, applicantId: id,
      source: { name: 'Test Source', url: 'https://example.test/src', document: 'p.12', publishedAt: null },
    });
  });
});

describe('PATCH status + offline conflicts (PRD §12)', () => {
  it('online patch persists, bumps status_updated_at, returns the item', async () => {
    const u = await onboarded();
    const id = await applicant(u);
    const item = (await as(u)('GET', `/v1/applicants/${id}/checklist`)).body.items[0];
    const r = await as(u)('PATCH', `/v1/checklist/${item.id}`, { status: 'issue_found' });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('issue_found');
    expect((await as(u)('GET', `/v1/checklist/${item.id}`)).body.status).toBe('issue_found');
  });

  it('validation: status must be one of the 4 writable; not_applicable rejected; bad body', async () => {
    const u = await onboarded();
    const id = await applicant(u);
    const item = (await as(u)('GET', `/v1/applicants/${id}/checklist`)).body.items[0];
    for (const body of [{ status: 'not_applicable' }, { status: 'done' }, {}, { status: 'ready', baseVersion: 0 }, { status: 'ready', clientMutationAt: 'x' }]) {
      expect((await as(u)('PATCH', `/v1/checklist/${item.id}`, body)).status).toBe(422);
    }
  });

  it('matching baseVersion applies; stale baseVersion → 409 CHECKLIST_CONFLICT, NOT applied, needs_review persisted', async () => {
    const u = await onboarded();
    const id = await applicant(u);
    const item = (await as(u)('GET', `/v1/applicants/${id}/checklist`)).body.items[0];
    const ok = await as(u)('PATCH', `/v1/checklist/${item.id}`, { status: 'in_progress', baseVersion: 1 });
    expect(ok.status).toBe(200);

    await q(`UPDATE requirements SET title = '{"en":"changed"}' WHERE code='passport'`); // version → 2
    const conflict = await as(u)('PATCH', `/v1/checklist/${item.id}`, { status: 'ready', baseVersion: 1 });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('CHECKLIST_CONFLICT');
    const now = await as(u)('GET', `/v1/checklist/${item.id}`);
    expect(now.body.status).toBe('in_progress'); // user's offline change was not silently applied
    expect(now.body.badges).toContain('needs_review');
    expect(now.body.requirementVersion).toBe(2);
  });

  it('acknowledge-review clears the badge; a fresh patch at the new version applies', async () => {
    const u = await onboarded();
    const id = await applicant(u);
    const item = (await as(u)('GET', `/v1/applicants/${id}/checklist`)).body.items[0];
    await q(`UPDATE requirements SET title = '{"en":"changed"}' WHERE code='passport'`);
    await as(u)('PATCH', `/v1/checklist/${item.id}`, { status: 'ready', baseVersion: 1 });
    const ack = await as(u)('POST', `/v1/checklist/${item.id}/acknowledge-review`);
    expect(ack.status).toBe(200);
    expect(ack.body.badges).not.toContain('needs_review');
    const ok = await as(u)('PATCH', `/v1/checklist/${item.id}`, { status: 'ready', baseVersion: 2 });
    expect(ok.body.status).toBe('ready');
  });

  it('item changed server-side after the offline mutation was made → conflict', async () => {
    const u = await onboarded();
    const id = await applicant(u);
    const item = (await as(u)('GET', `/v1/applicants/${id}/checklist`)).body.items[0];
    const offlineAt = new Date(Date.now() - 60_000).toISOString();
    await as(u)('PATCH', `/v1/checklist/${item.id}`, { status: 'in_progress' }); // other device, just now
    const r = await as(u)('PATCH', `/v1/checklist/${item.id}`, { status: 'ready', clientMutationAt: offlineAt });
    expect(r.body.error.code).toBe('CHECKLIST_CONFLICT');
    expect((await as(u)('GET', `/v1/checklist/${item.id}`)).body.status).toBe('in_progress');
    const later = await as(u)('PATCH', `/v1/checklist/${item.id}`, {
      status: 'ready', clientMutationAt: new Date(Date.now() + 1000).toISOString(),
    });
    expect(later.status).toBe(200);
  });
});

describe('access levels on checklist writes (PRD §7)', () => {
  it.each([
    ['grace_read_only', `premium_status='expired_pending_confirmation', grace_until=now()+interval '5 days'`],
    ['expired', `premium_status='expired'`],
  ])('%s: reads allowed, patch + acknowledge → 403 APPLICANT_READ_ONLY, nothing changes', async (_n, set) => {
    const u = await onboarded();
    const id = await applicant(u);
    const item = (await as(u)('GET', `/v1/applicants/${id}/checklist`)).body.items[0];
    await q(`UPDATE applicants SET ${set}`);
    const get = await as(u)('GET', `/v1/checklist/${item.id}`);
    expect(get.status).toBe(200);
    expect(get.body.canWrite).toBe(false);
    expect((await as(u)('GET', `/v1/applicants/${id}/checklist?limit=50`)).body.lockedCount).toBe(0); // full view, read-only
    for (const r of [
      await as(u)('PATCH', `/v1/checklist/${item.id}`, { status: 'ready' }),
      await as(u)('POST', `/v1/checklist/${item.id}/acknowledge-review`),
    ]) {
      expect(r.status).toBe(403);
      expect(r.body.error.code).toBe('APPLICANT_READ_ONLY');
    }
    expect((await q<{ status: string }>(`SELECT status FROM applicant_requirements WHERE id=$1`, [item.id]))[0]!.status).toBe('not_started');
  });
});

describe('journey (Screen 12)', () => {
  it('8 stages in order, state relative to currentStage, counts applicable items only', async () => {
    const u = await onboarded();
    const id = await applicant(u, wife, 'documents');
    const doc = (await q<{ id: string }>(
      `SELECT ar.id FROM applicant_requirements ar JOIN requirements r ON r.id=ar.requirement_id WHERE r.code='nikah'`))[0]!.id;
    await premium(id);
    await as(u)('PATCH', `/v1/checklist/${doc}`, { status: 'ready' });
    const r = await as(u)('GET', `/v1/applicants/${id}/journey`);
    expect(r.status).toBe(200);
    expect(r.body.currentStage).toBe('documents');
    expect(r.body.stages.map((s: any) => s.stage)).toEqual([
      'eligibility', 'nulla_osta', 'documents', 'translation', 'appointment', 'application', 'processing', 'decision',
    ]);
    expect(r.body.stages.map((s: any) => s.state)).toEqual([
      'done', 'done', 'current', 'upcoming', 'upcoming', 'upcoming', 'upcoming', 'upcoming',
    ]);
    const docs = r.body.stages[2];
    expect(docs).toMatchObject({ itemCount: 3, readyCount: 1 }); // nikah + adult_only + minor_only (DOB unknown)
  });

  it('no stage yet → all upcoming', async () => {
    const u = await onboarded();
    const a = (await as(u)('POST', '/v1/applicants', wife)).body.applicant;
    const r = await as(u)('GET', `/v1/applicants/${a.id}/journey`);
    expect(r.body.currentStage).toBeNull();
    expect(r.body.stages.every((s: any) => s.state === 'upcoming' && s.itemCount === 0)).toBe(true);
  });
});

describe('readiness on the applicant (invariant 8: derived, never stored)', () => {
  it('percent, blocking, N/A and category-specific counts', async () => {
    const u = await onboarded();
    const id = await applicant(u);
    const base = (await as(u)('GET', `/v1/applicants/${id}`)).body.readiness;
    expect(base).toEqual({
      percent: 0, applicableCount: 6, readyCount: 0, blockingCount: 3, notApplicableCount: 4, categorySpecificCount: 1,
    });
    const item = (await q<{ id: string }>(
      `SELECT ar.id FROM applicant_requirements ar JOIN requirements r ON r.id=ar.requirement_id WHERE r.code='passport'`))[0]!.id;
    await as(u)('PATCH', `/v1/checklist/${item}`, { status: 'ready' });
    const after = (await as(u)('GET', '/v1/applicants')).body.applicants[0].readiness;
    expect(after).toMatchObject({ percent: 17, readyCount: 1, blockingCount: 2 });
  });

  it('is all zeros before a case exists', async () => {
    const u = await onboarded();
    const a = (await as(u)('POST', '/v1/applicants', wife)).body.applicant;
    expect(a.readiness).toEqual({
      percent: 0, applicableCount: 0, readyCount: 0, blockingCount: 0, notApplicableCount: 0, categorySpecificCount: 0,
    });
  });
});

describe('ownership — cross-user 404 on every verb (Gate 3, mandatory)', () => {
  it("B gets 404 (never 403/402) on A's checklist, item, journey and writes; A's data unchanged", async () => {
    const a = await onboarded();
    const b = await onboarded();
    const aid = await applicant(a);
    await premium(aid);
    const item = (await as(a)('GET', `/v1/applicants/${aid}/checklist`)).body.items[0];

    const attempts = [
      await as(b)('GET', `/v1/applicants/${aid}/checklist`),
      await as(b)('GET', `/v1/applicants/${aid}/journey`),
      await as(b)('GET', `/v1/checklist/${item.id}`),
      await as(b)('PATCH', `/v1/checklist/${item.id}`, { status: 'ready' }),
      await as(b)('POST', `/v1/checklist/${item.id}/acknowledge-review`),
    ];
    for (const r of attempts) {
      expect(r.status).toBe(404);
      expect(r.body.error.code).toBe('NOT_FOUND');
    }
    const ghost = await as(b)('GET', `/v1/checklist/${randomUUID()}`);
    expect(ghost.body.error.message).toBe(attempts[2]!.body.error.message);
    expect((await q<{ status: string; needs_review: boolean }>(
      `SELECT status, needs_review FROM applicant_requirements WHERE id=$1`, [item.id]))[0]).toEqual({ status: 'not_started', needs_review: false });
  });

  it('a free B cannot learn that A\'s locked item exists (404, not 402)', async () => {
    const a = await onboarded();
    const b = await onboarded();
    await applicant(a);
    await applicant(b);
    const locked = (await q<{ id: string }>(
      `SELECT ar.id FROM applicant_requirements ar JOIN requirements r ON r.id = ar.requirement_id
        JOIN applicants ap ON ap.id = ar.applicant_id JOIN users u ON u.id = ap.user_id
        WHERE r.code='appointment_slot' AND u.firebase_uid=$1`, [a.uid]))[0]!.id;
    expect((await as(b)('GET', `/v1/checklist/${locked}`)).status).toBe(404);
  });

  it('401 without a session; 422 for non-uuid ids', async () => {
    const u = await onboarded();
    const id = await applicant(u);
    expect((await call('GET', `/v1/applicants/${id}/checklist`)).status).toBe(401);
    expect((await call('GET', `/v1/checklist/${id}`)).status).toBe(401);
    expect((await as(u)('GET', '/v1/checklist/nope')).status).toBe(422);
    expect((await as(u)('GET', '/v1/applicants/nope/checklist')).status).toBe(422);
  });
});
