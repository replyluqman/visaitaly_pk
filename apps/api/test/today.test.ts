import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { as, call, env, login, newUser, store, type TestUser } from './helpers/app.js';
import { closePool, q, resetDb, seedCatalogue, seedLegal } from './helpers/db.js';
import { createDb } from '../src/db/client.js';
import { refreshNextActions } from '../src/modules/today/today.service.js';

beforeEach(async () => {
  await resetDb();
  store.objects.clear();
  await seedLegal();
  await seedCatalogue();
});
afterAll(closePool);

async function onboarded(): Promise<TestUser> {
  const id = (await q<{ id: string }>(`SELECT id FROM legal_versions WHERE is_current`))[0]!.id;
  const u = newUser();
  await login(u);
  await as(u)('POST', '/v1/legal/accept', { versionIds: [id] });
  return u;
}
async function applicant(u: TestUser, stage = 'documents', paid = true, name = 'Ayesha'): Promise<string> {
  const r = await as(u)('POST', '/v1/applicants', {
    displayName: name, relationshipCode: 'wife', currentLocation: 'pakistan', currentStage: stage,
  });
  const id = r.body.applicant.id as string;
  if (paid) await q(`UPDATE applicants SET premium_status='active', access_until=now()+interval '30 days' WHERE id=$1`, [id]);
  return id;
}
async function refresh(): Promise<number> {
  const { db, close } = await createDb({ ...env, HYPERDRIVE: { connectionString: process.env.TEST_DATABASE_URL! } });
  try {
    return (await refreshNextActions(db)).refreshed;
  } finally {
    await close();
  }
}
const today = (u: TestUser, qs = '') => as(u)('GET', `/v1/today${qs}`);
const itemId = async (code: string, applicantId: string) =>
  (await q<{ id: string }>(
    `SELECT ar.id FROM applicant_requirements ar JOIN requirements r ON r.id=ar.requirement_id
      WHERE r.code=$1 AND ar.applicant_id=$2`, [code, applicantId]))[0]!.id;

describe('materialisation (Cron)', () => {
  it('Today is a read of next_actions: nothing is computed on the request path', async () => {
    const u = await onboarded();
    await applicant(u);
    const before = await today(u);
    expect(before.status).toBe(200);
    expect(before.body.actions).toEqual([]); // not materialised yet, even though work exists
    expect(before.body.computedAt).toBeNull();
    expect(await q(`SELECT 1 FROM next_actions`)).toHaveLength(0);
    expect(await refresh()).toBe(1);
    expect((await today(u)).body.actions.length).toBeGreaterThan(0);
  });

  it('ranks expiring → blocking → todo; an item appears once at its best rank; capped by config', async () => {
    const u = await onboarded();
    const a = await applicant(u, 'documents');
    // a document on `nikah` (blocking AND in the current stage) expiring in 5 days
    const nikah = await itemId('nikah', a);
    await q(
      `INSERT INTO documents (user_id, applicant_id, applicant_requirement_id, r2_key, mime, size_bytes, client_sha256, status, completed_at, expiry_date)
       SELECT user_id, id, $2, 'k1', 'image/png', 10, repeat('a',64), 'active', now(), CURRENT_DATE + 5 FROM applicants WHERE id=$1`, [a, nikah]);
    await q(`UPDATE applicants SET nulla_osta_status='received', nulla_osta_issue_date=CURRENT_DATE - 160, nulla_osta_expiry_date=CURRENT_DATE + 20 WHERE id=$1`, [a]);
    await refresh();
    const r = await today(u);
    expect(r.status).toBe(200);
    const acts = r.body.actions as any[];
    expect(acts.length).toBe(5);
    expect(acts[0]).toMatchObject({ kind: 'expiring', reason: 'document_expires', title: 'nikah', itemId: nikah, deepLink: `/checklist/${nikah}` });
    expect(acts[1]).toMatchObject({ kind: 'expiring', reason: 'nulla_osta_expires', title: null, itemId: null, deepLink: `/applicants/${a}` });
    expect(acts[0].dueDate < acts[1].dueDate).toBe(true);
    // blocking next: passport (stage eligibility) and appointment_slot are blocking; nikah already listed as expiring
    expect(acts.slice(2).map((x) => x.kind)).toEqual(['blocking', 'blocking', 'todo']);
    expect(acts.filter((x) => x.itemId === nikah)).toHaveLength(1);
    expect(r.body.allClear).toBeNull();
    expect(r.body.computedAt).not.toBeNull();

    await q(`UPDATE app_config SET value = jsonb_set(value,'{max_actions}','2') WHERE key='today'`);
    try {
      await refresh();
      expect((await today(u)).body.actions).toHaveLength(2);
    } finally {
      await q(`UPDATE app_config SET value = jsonb_set(value,'{max_actions}','5') WHERE key='today'`);
    }
  });

  it('todo ordering: issue found before in progress before not started; ready items drop out', async () => {
    const u = await onboarded();
    const a = await applicant(u, 'documents');
    await q(`UPDATE requirements SET blocks_submission = false`);
    await q(`UPDATE applicant_requirements SET status='issue_found' WHERE id=$1`, [await itemId('adult_only', a)]);
    await q(`UPDATE applicant_requirements SET status='in_progress' WHERE id=$1`, [await itemId('nikah', a)]);
    await q(`UPDATE applicant_requirements SET status='ready' WHERE id=$1`, [await itemId('minor_only', a)]);
    await refresh();
    const acts = (await today(u)).body.actions as any[];
    expect(acts.map((x) => [x.title, x.reason])).toEqual([
      ['adult_only', 'issue_found'], ['nikah', 'in_progress'],
    ]);
  });

  it('refreshes after a status change on the next run; allClear reports the next stage', async () => {
    const u = await onboarded();
    const a = await applicant(u, 'eligibility');
    await q(`UPDATE requirements SET blocks_submission = false`);
    await q(`UPDATE applicant_requirements SET status='ready' WHERE applicant_id=$1`, [a]);
    await refresh();
    const r = await today(u);
    expect(r.body.actions).toEqual([]);
    expect(r.body.allClear).toEqual({ nextStage: 'nulla_osta' });
  });

  it('batch_size refreshes the stalest applicants first; applicants without a case are skipped', async () => {
    const u = await onboarded();
    // created first, while onboarding is incomplete, so a stage-less applicant is allowed
    const noCase = await as(u)('POST', '/v1/applicants', { displayName: 'C', relationshipCode: 'wife', currentLocation: 'pakistan' });
    expect(noCase.status).toBe(201);
    const a1 = await applicant(u, 'documents', true, 'A');
    const a2 = await applicant(u, 'documents', true, 'B');
    await q(`UPDATE app_config SET value = jsonb_set(value,'{batch_size}','1') WHERE key='today'`);
    try {
      expect(await refresh()).toBe(1);
      expect(await refresh()).toBe(1);
      const rows = await q<{ applicant_id: string }>(`SELECT applicant_id FROM next_actions`);
      expect(rows.map((r) => r.applicant_id).sort()).toEqual([a1, a2].sort());
      await q(`UPDATE next_actions SET computed_at = now() - interval '1 hour' WHERE applicant_id=$1`, [a2]);
      await refresh(); // a2 is now the stalest
      const fresh = await q<{ fresh: boolean }>(`SELECT computed_at > now() - interval '1 minute' AS fresh FROM next_actions WHERE applicant_id=$1`, [a2]);
      expect(fresh[0]?.fresh).toBe(true);
      expect(await q(`SELECT 1 FROM next_actions WHERE applicant_id=$1`, [noCase.body.applicant.id])).toHaveLength(0);
    } finally {
      await q(`UPDATE app_config SET value = jsonb_set(value,'{batch_size}','5000') WHERE key='today'`);
    }
  });

  it('is idempotent', async () => {
    const u = await onboarded();
    await applicant(u);
    await refresh();
    const first = (await today(u)).body.actions;
    await refresh();
    expect((await today(u)).body.actions).toEqual(first);
    expect(await q(`SELECT 1 FROM next_actions`)).toHaveLength(1);
  });
});

describe('access (PRD §8: premium feature)', () => {
  it('free → 402 PREMIUM_REQUIRED; expired → 402; grace → readable', async () => {
    const u = await onboarded();
    const a = await applicant(u, 'documents', false);
    await refresh();
    const free = await today(u);
    expect(free.status).toBe(402);
    expect(free.body.error.code).toBe('PREMIUM_REQUIRED');

    await q(`UPDATE applicants SET premium_status='expired' WHERE id=$1`, [a]);
    expect((await today(u)).status).toBe(402);

    await q(`UPDATE applicants SET premium_status='expired_pending_confirmation', grace_until=now()+interval '5 days' WHERE id=$1`, [a]);
    expect((await today(u)).status).toBe(200);
  });

  it('a free applicant contributes nothing when another is premium', async () => {
    const u = await onboarded();
    const paid = await applicant(u, 'documents', true, 'Paid');
    await applicant(u, 'documents', false, 'Free');
    await refresh();
    const acts = (await today(u)).body.actions as any[];
    expect(acts.length).toBeGreaterThan(0);
    expect(new Set(acts.map((x) => x.applicantId))).toEqual(new Set([paid]));
  });

  it('merges across a user’s premium applicants and keeps the global ranking', async () => {
    const u = await onboarded();
    const a = await applicant(u, 'documents', true, 'A');
    const b = await applicant(u, 'documents', true, 'B');
    await q(`UPDATE applicants SET nulla_osta_status='received', nulla_osta_issue_date=CURRENT_DATE - 160, nulla_osta_expiry_date=CURRENT_DATE + 3 WHERE id=$1`, [b]);
    await refresh();
    const acts = (await today(u)).body.actions as any[];
    expect(acts[0]).toMatchObject({ kind: 'expiring', applicantId: b });
    expect(new Set(acts.map((x) => x.applicantId))).toEqual(new Set([a, b]));
    expect(acts.length).toBeLessThanOrEqual(5);
  });
});

describe('ownership', () => {
  it("B never sees A's actions (user_id in the WHERE); 401 without a session", async () => {
    const a = await onboarded();
    const b = await onboarded();
    await applicant(a, 'documents', true, 'A');
    const bb = await applicant(b, 'eligibility', true, 'B');
    await q(`UPDATE requirements SET blocks_submission = false`);
    await q(`UPDATE applicant_requirements SET status='ready' WHERE applicant_id=$1`, [bb]);
    await refresh();
    expect((await today(b)).body.actions).toEqual([]); // not A's
    expect((await today(a)).body.actions.length).toBeGreaterThan(0);
    expect((await call('GET', '/v1/today')).status).toBe(401);
  });

  it('locale: title falls back to en', async () => {
    const u = await onboarded();
    await applicant(u, 'documents');
    await refresh();
    const acts = (await today(u, '?locale=ur')).body.actions as any[];
    expect(acts[0].title).not.toBeNull();
  });
});
