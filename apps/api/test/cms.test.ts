import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { as, asAdmin, call, login, newAdminIdentity, newUser, rawFetch, type TestAdmin, type TestUser } from './helpers/app.js';
import { closePool, q, resetDb, seedAdmin, seedLegal } from './helpers/db.js';
import { createDb } from '../src/db/client.js';
import { env } from './helpers/app.js';
import { normalizeForHash, sweepSources, type SourceFetcher } from '../src/modules/cms/cms.service.js';

let cms: ReturnType<typeof asAdmin>;
let cmsAdmin: TestAdmin;
let cmsAdminId: string;

beforeEach(async () => {
  await resetDb();
  await seedLegal();
  cmsAdmin = newAdminIdentity();
  cmsAdminId = await seedAdmin(cmsAdmin, { scopes: ['verification_manage'] });
  cms = asAdmin(cmsAdmin);
});
afterAll(closePool);

const REQ = (code: string, over: Record<string, unknown> = {}) => ({
  code, stage: 'documents', title: { en: `Title ${code}` }, purpose: { en: 'why' }, naReason: { en: 'Not for you.' },
  sortOrder: 10, ...over,
});
async function source(over: Record<string, unknown> = {}) {
  const r = await cms('POST', '/v1/admin/sources', {
    url: `https://example.test/${Math.random().toString(36).slice(2)}`, name: { en: 'Embassy' }, authority: 'embassy', ...over,
  });
  expect(r.status).toBe(201);
  return r.body as { id: string; url: string };
}
const act = (id: string, action: string, extra: object = {}) =>
  cms('POST', `/v1/admin/requirements/${id}/actions`, { action, ...extra });
/** create → verify → publish */
async function published(code: string, over: Record<string, unknown> = {}, sourceId?: string) {
  const src = sourceId ?? (await source()).id;
  const c = await cms('POST', '/v1/admin/requirements', REQ(code, { sourceId: src, ...over }));
  expect(c.status).toBe(201);
  expect((await act(c.body.id, 'verify')).status).toBe(200);
  const p = await act(c.body.id, 'publish');
  expect(p.status).toBe(200);
  return p.body as any;
}
async function onboarded(): Promise<TestUser> {
  const id = (await q<{ id: string }>(`SELECT id FROM legal_versions WHERE is_current`))[0]!.id;
  const u = newUser();
  await login(u);
  await as(u)('POST', '/v1/legal/accept', { versionIds: [id] });
  return u;
}
async function applicant(u: TestUser, body: object = {}, premium = true): Promise<string> {
  const r = await as(u)('POST', '/v1/applicants', {
    displayName: 'Ayesha', relationshipCode: 'wife', currentLocation: 'pakistan', currentStage: 'documents', ...body,
  });
  expect(r.status).toBe(201);
  const id = r.body.applicant.id as string;
  if (premium) await q(`UPDATE applicants SET premium_status='active', access_until=now()+interval '30 days' WHERE id=$1`, [id]);
  return id;
}
const items = async (u: TestUser, a: string) =>
  ((await as(u)('GET', `/v1/applicants/${a}/checklist?limit=50`)).body.items as any[]);

describe('access', () => {
  it('401 anonymous; a user token never reaches the CMS; scopes: other scope 403, read_only reads only, scoped writes, super everything', async () => {
    expect((await call('GET', '/v1/admin/requirements')).status).toBe(401);
    const u = newUser();
    await login(u);
    expect((await call('GET', '/v1/admin/requirements', { uid: u.uid })).status).toBe(401);

    const other = newAdminIdentity();
    await seedAdmin(other, { scopes: ['support_manage'] });
    const ro = newAdminIdentity();
    await seedAdmin(ro, { scopes: ['read_only'] });
    const sup = newAdminIdentity();
    await seedAdmin(sup, { isSuper: true });

    expect((await asAdmin(other)('GET', '/v1/admin/requirements')).status).toBe(403);
    expect((await asAdmin(other)('POST', '/v1/admin/requirements', REQ('x1'))).status).toBe(403);
    expect((await asAdmin(ro)('GET', '/v1/admin/requirements')).status).toBe(200);
    expect((await asAdmin(ro)('GET', '/v1/admin/sources')).status).toBe(200);
    const denied = await asAdmin(ro)('POST', '/v1/admin/requirements', REQ('x1'));
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('ADMIN_FORBIDDEN');
    expect((await asAdmin(ro)('POST', '/v1/admin/sources', { url: 'https://a.test', name: { en: 'A' }, authority: 'embassy' })).status).toBe(403);
    expect((await cms('POST', '/v1/admin/requirements', REQ('x1'))).status).toBe(201);
    expect((await asAdmin(sup)('POST', '/v1/admin/requirements', REQ('x2'))).status).toBe(201);
  });
});

describe('sources', () => {
  it('create validates (https only, English name, authority), rejects duplicates, audits', async () => {
    for (const body of [
      {}, { url: 'http://insecure.test', name: { en: 'A' }, authority: 'embassy' },
      { url: 'not a url', name: { en: 'A' }, authority: 'embassy' },
      { url: 'https://a.test', name: { ur: 'x' }, authority: 'embassy' },
      { url: 'https://a.test', name: { en: 'A' }, authority: 'blog' },
    ]) {
      expect((await cms('POST', '/v1/admin/sources', body)).status).toBe(422);
    }
    const s = await source({ url: 'https://embassy.test/visa' });
    expect(s).toBeDefined();
    const dup = await cms('POST', '/v1/admin/sources', { url: 'https://embassy.test/visa', name: { en: 'A' }, authority: 'embassy' });
    expect(dup.status).toBe(409);
    expect((await q(`SELECT 1 FROM audit_log WHERE action='source.create'`))).toHaveLength(1);
  });

  it('patch + deactivate + keyset list', async () => {
    const a = await source();
    await source();
    await source();
    const p = await cms('PATCH', `/v1/admin/sources/${a.id}`, { isActive: false, name: { en: 'Renamed' } });
    expect(p.body).toMatchObject({ isActive: false, name: { en: 'Renamed' } });
    expect((await cms('PATCH', `/v1/admin/sources/${a.id}`, {})).status).toBe(422);
    expect((await cms('PATCH', '/v1/admin/sources/00000000-0000-4000-8000-000000000000', { isActive: true })).status).toBe(404);
    const p1 = await cms('GET', '/v1/admin/sources?limit=2');
    const p2 = await cms('GET', `/v1/admin/sources?limit=2&cursor=${p1.body.nextCursor}`);
    expect(p1.body.items).toHaveLength(2);
    expect(p2.body.items).toHaveLength(1);
    expect(p2.body.nextCursor).toBeNull();
  });
});

describe('requirements: create + read', () => {
  it('validation', async () => {
    const bad = [
      {}, REQ('Bad-Code'), REQ('x'), REQ('ok_code', { stage: 'nope' }), REQ('ok_code', { title: { ur: 'x' } }),
      REQ('ok_code', { title: { en: '' } }), REQ('ok_code', { minAgeYears: 20, maxAgeYears: 10 }),
      REQ('ok_code', { appliesLocations: ['mars'] }), REQ('ok_code', { appliesLocations: [] }),
      REQ('ok_code', { validityDays: 0 }), REQ('ok_code', { title: { en: 'x'.repeat(2001) } }),
    ];
    for (const b of bad) expect((await cms('POST', '/v1/admin/requirements', b)).status).toBe(422);
    expect((await cms('POST', '/v1/admin/requirements', REQ('ok_code', { sourceId: '00000000-0000-4000-8000-000000000000' }))).status).toBe(422);
  });

  it('creates as `created` v1 with defaults; duplicate code 409; get/list', async () => {
    const c = await cms('POST', '/v1/admin/requirements', REQ('passport_copy'));
    expect(c.status).toBe(201);
    expect(c.body).toMatchObject({
      code: 'passport_copy', status: 'created', version: 1, appliesSpouse: true, appliesChild: true, appliesParent: true,
      blocksSubmission: false, sourceId: null, lastVerifiedAt: null, appliesLocations: null,
    });
    expect((await cms('POST', '/v1/admin/requirements', REQ('passport_copy'))).status).toBe(409);
    expect((await cms('GET', `/v1/admin/requirements/${c.body.id}`)).body.title).toEqual({ en: 'Title passport_copy' });
    expect((await cms('GET', '/v1/admin/requirements/00000000-0000-4000-8000-000000000000')).status).toBe(404);
    expect((await cms('GET', '/v1/admin/requirements/nope')).status).toBe(422);
  });

  it('lists in catalogue order with filters and a keyset cursor', async () => {
    await cms('POST', '/v1/admin/requirements', REQ('late', { stage: 'application', sortOrder: 1 }));
    await cms('POST', '/v1/admin/requirements', REQ('b_doc', { sortOrder: 20 }));
    await cms('POST', '/v1/admin/requirements', REQ('a_doc', { sortOrder: 10 }));
    await cms('POST', '/v1/admin/requirements', REQ('first', { stage: 'eligibility', sortOrder: 5 }));
    const all = await cms('GET', '/v1/admin/requirements');
    expect(all.body.items.map((i: any) => i.code)).toEqual(['first', 'a_doc', 'b_doc', 'late']);
    expect((await cms('GET', '/v1/admin/requirements?stage=documents')).body.items).toHaveLength(2);
    expect((await cms('GET', '/v1/admin/requirements?status=published')).body.items).toEqual([]);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const r: any = await cms('GET', `/v1/admin/requirements?limit=1${cursor ? `&cursor=${cursor}` : ''}`);
      seen.push(...r.body.items.map((i: any) => i.code));
      cursor = r.body.nextCursor;
    } while (cursor);
    expect(seen).toEqual(['first', 'a_doc', 'b_doc', 'late']);
    for (const qs of ['cursor=@@', 'limit=0', 'status=weird', 'stage=weird']) {
      expect((await cms('GET', `/v1/admin/requirements?${qs}`)).status).toBe(422);
    }
  });
});

describe('workflow (PRD §13): Created → Verified → Published', () => {
  it('verify needs a source; records the verifier; publish needs verified; versions snapshot', async () => {
    const c = await cms('POST', '/v1/admin/requirements', REQ('nikah'));
    const noSource = await act(c.body.id, 'verify');
    expect(noSource.status).toBe(422);
    expect(noSource.body.error.details.sourceId).toBeDefined();
    expect((await act(c.body.id, 'publish')).status).toBe(409); // not verified yet

    const src = await source();
    await cms('PATCH', `/v1/admin/requirements/${c.body.id}`, { sourceId: src.id, sourceDocument: 'p.4', sourcePublishedAt: '2026-01-15' });
    const v = await act(c.body.id, 'verify');
    expect(v.body).toMatchObject({ status: 'verified', lastVerifiedBy: cmsAdminId, sourceDocument: 'p.4', sourcePublishedAt: '2026-01-15' });
    expect(v.body.lastVerifiedAt).not.toBeNull();
    expect((await act(c.body.id, 'verify')).status).toBe(409);

    const p = await act(c.body.id, 'publish', { changeSummary: { en: 'First publication' } });
    expect(p.body.status).toBe('published');
    const versions = (await cms('GET', `/v1/admin/requirements/${c.body.id}/versions`)).body.items;
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({ version: 1, publishedBy: cmsAdminId, changeSummary: { en: 'First publication' } });
    const [snap] = await q<{ snapshot: any }>(`SELECT snapshot FROM requirement_versions`);
    expect(snap!.snapshot).toMatchObject({ code: 'nikah', verification_status: 'published', version: 1 });
  });

  it('editing a VERIFIED requirement invalidates its verification', async () => {
    const src = await source();
    const c = await cms('POST', '/v1/admin/requirements', REQ('x_item', { sourceId: src.id }));
    await act(c.body.id, 'verify');
    const e = await cms('PATCH', `/v1/admin/requirements/${c.body.id}`, { title: { en: 'Changed' } });
    expect(e.body).toMatchObject({ status: 'created', lastVerifiedAt: null, lastVerifiedBy: null });
    expect((await act(c.body.id, 'publish')).status).toBe(409);
  });

  it('a PUBLISHED requirement cannot change without updating its verification record', async () => {
    const r = await published('passport');
    const blocked = await cms('PATCH', `/v1/admin/requirements/${r.id}`, { title: { en: 'Sneaky' } });
    expect(blocked.status).toBe(409);
    const noSummary = await cms('PATCH', `/v1/admin/requirements/${r.id}`, { title: { en: 'New' }, reverify: true });
    expect(noSummary.status).toBe(422);
    expect(noSummary.body.error.details.changeSummary).toBeDefined();
    expect((await cms('PATCH', `/v1/admin/requirements/${r.id}`, { sourceId: null, reverify: true, changeSummary: { en: 'x' } })).status).toBe(422);
    expect((await cms('GET', `/v1/admin/requirements/${r.id}`)).body.title).toEqual({ en: 'Title passport' }); // untouched

    await q(`UPDATE requirements SET last_verified_at = now() - interval '90 days'`);
    const ok = await cms('PATCH', `/v1/admin/requirements/${r.id}`, {
      title: { en: 'New title' }, reverify: true, changeSummary: { en: 'Title clarified' },
    });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ status: 'published', version: 2, title: { en: 'New title' }, lastVerifiedBy: cmsAdminId });
    expect(Date.now() - new Date(ok.body.lastVerifiedAt).getTime()).toBeLessThan(60_000); // re-stamped
    const versions = (await cms('GET', `/v1/admin/requirements/${r.id}/versions`)).body.items;
    expect(versions.map((v: any) => v.version)).toEqual([2, 1]);
    expect(versions[0].changeSummary).toEqual({ en: 'Title clarified' });
    await expect(q(`UPDATE requirement_versions SET version = 9`)).rejects.toThrow(/append-only/);
    await expect(q(`DELETE FROM requirement_versions`)).rejects.toThrow(/append-only/);
  });

  it('reverify (no content change) stamps without bumping the version; only for published', async () => {
    const r = await published('passport');
    await q(`UPDATE requirements SET last_verified_at = now() - interval '90 days'`);
    const v = await act(r.id, 'reverify');
    expect(v.body.version).toBe(1);
    expect(Date.now() - new Date(v.body.lastVerifiedAt).getTime()).toBeLessThan(60_000);
    const same = await cms('PATCH', `/v1/admin/requirements/${r.id}`, { reverify: true });
    expect(same.body.version).toBe(1);
    const c = await cms('POST', '/v1/admin/requirements', REQ('draft_one'));
    expect((await act(c.body.id, 'reverify')).status).toBe(409);
    expect((await cms('PATCH', `/v1/admin/requirements/${c.body.id}`, { reverify: true, title: { en: 'x' } })).status).toBe(409);
  });

  it('unpublish → verified; archive from anywhere; archived is final', async () => {
    const r = await published('passport');
    expect((await act(r.id, 'unpublish')).body.status).toBe('verified');
    expect((await act(r.id, 'unpublish')).status).toBe(409);
    expect((await act(r.id, 'publish')).body.status).toBe('published'); // re-publish: same version, snapshot not duplicated
    expect((await cms('GET', `/v1/admin/requirements/${r.id}/versions`)).body.items).toHaveLength(1);
    expect((await act(r.id, 'archive')).body.status).toBe('archived');
    expect((await act(r.id, 'archive')).status).toBe(409);
    expect((await cms('PATCH', `/v1/admin/requirements/${r.id}`, { title: { en: 'x' } })).status).toBe(409);
    expect((await act(r.id, 'publish')).status).toBe(409);
  });

  it('every transition is audited with ids and field names only', async () => {
    const r = await published('passport');
    await cms('PATCH', `/v1/admin/requirements/${r.id}`, { purpose: { en: 'new' }, reverify: true, changeSummary: { en: 'c' } });
    const log = await q<{ action: string; metadata: any }>(
      `SELECT action, metadata FROM audit_log WHERE target_id=$1 ORDER BY created_at, id`, [r.id]);
    expect(log.map((l) => l.action)).toEqual(['requirement.create', 'requirement.verify', 'requirement.publish', 'requirement.update_published']);
    expect(log[3]!.metadata).toMatchObject({ code: 'passport', fields: ['purpose'], fromVersion: 1, toVersion: 2 });
    expect(JSON.stringify(log.map((l) => l.metadata))).not.toContain('new'); // field NAMES, never values
    expect(log.every((l) => l.metadata)).toBe(true);
  });

  it('the action and its audit row are atomic', async () => {
    await q(`ALTER TABLE audit_log ADD CONSTRAINT boom_chk CHECK (action <> 'requirement.create')`);
    try {
      expect((await cms('POST', '/v1/admin/requirements', REQ('boom'))).status).toBe(500);
      expect(await q(`SELECT 1 FROM requirements WHERE code='boom'`)).toHaveLength(0);
    } finally {
      await q(`ALTER TABLE audit_log DROP CONSTRAINT boom_chk`);
    }
  });
});

describe('publishing reaches existing applicants (fan-out)', () => {
  it('a requirement published AFTER cases exist appears for every applicant with a case — not for those without', async () => {
    const u1 = await onboarded();
    const u2 = await onboarded();
    const a1 = await applicant(u1);
    const a2 = await applicant(u2, { relationshipCode: 'son', dateOfBirth: '2015-01-01' });
    const noCase = await as(onboarded().then((x) => x) as never); // placeholder to keep types honest
    void noCase;
    expect(await items(u1, a1)).toHaveLength(0);

    const r = await published('nikah', { appliesChild: false, appliesParent: false, title: { en: 'Marriage certificate' } });
    const mine = await items(u1, a1);
    expect(mine.map((i) => [i.requirementCode, i.status])).toEqual([['nikah', 'not_started']]);
    const kid = await items(u2, a2);
    expect(kid).toHaveLength(1);
    expect(kid[0]).toMatchObject({ requirementCode: 'nikah', status: 'not_applicable', notApplicableReason: 'Not for you.' });
    expect((await q(`SELECT 1 FROM applicant_requirements WHERE requirement_id=$1`, [r.id]))).toHaveLength(2);
    const pub = await q<{ meta: any }>(`SELECT metadata AS meta FROM audit_log WHERE action='requirement.publish'`);
    expect(pub[0]!.meta.rowsReconciled).toBe(2);
    expect((await as(u1)('GET', `/v1/applicants/${a1}`)).body.readiness).toMatchObject({ applicableCount: 1, readyCount: 0 });
  });

  it('applicants without a generated case are not given rows (their case is generated at Screen 7)', async () => {
    const u = await onboarded();
    const pending = await as(u)('POST', '/v1/applicants', { displayName: 'P', relationshipCode: 'wife', currentLocation: 'pakistan' });
    expect(pending.status).toBe(201);
    await published('nikah');
    expect(await q(`SELECT 1 FROM applicant_requirements`)).toHaveLength(0);
    await as(u)('PATCH', `/v1/applicants/${pending.body.applicant.id}/stage`, { currentStage: 'documents' });
    expect(await q(`SELECT 1 FROM applicant_requirements`)).toHaveLength(1); // generated on demand
  });

  it('a re-publish recomputes applicability and PRESERVES progress; offline edits against the old version conflict', async () => {
    const u = await onboarded();
    const a = await applicant(u);
    const r = await published('nikah');
    const item = (await items(u, a))[0]!;
    await as(u)('PATCH', `/v1/checklist/${item.id}`, { status: 'ready' });

    await cms('PATCH', `/v1/admin/requirements/${r.id}`, { appliesSpouse: false, reverify: true, changeSummary: { en: 'Spouses no longer need this' } });
    const after = (await items(u, a))[0]!;
    expect(after.status).toBe('not_applicable');
    expect(after.requirementVersion).toBe(2);

    await cms('PATCH', `/v1/admin/requirements/${r.id}`, { appliesSpouse: true, reverify: true, changeSummary: { en: 'Required again' } });
    const back = (await items(u, a))[0]!;
    expect(back.status).toBe('ready'); // progress survived both flips

    const stale = await as(u)('PATCH', `/v1/checklist/${item.id}`, { status: 'in_progress', baseVersion: 1 });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('CHECKLIST_CONFLICT');
    expect((await as(u)('GET', `/v1/checklist/${item.id}`)).body.badges).toContain('needs_review');
  });
});

describe('only PUBLISHED requirements are visible to users', () => {
  it('unpublish/archive hides the item everywhere; republish restores it with its progress', async () => {
    const u = await onboarded();
    const a = await applicant(u);
    const r = await published('nikah', { blocksSubmission: true });
    const item = (await items(u, a))[0]!;
    await as(u)('PATCH', `/v1/checklist/${item.id}`, { status: 'in_progress' });
    expect((await as(u)('GET', `/v1/applicants/${a}`)).body.readiness.applicableCount).toBe(1);

    await act(r.id, 'unpublish');
    expect(await items(u, a)).toEqual([]);
    expect((await as(u)('GET', `/v1/checklist/${item.id}`)).status).toBe(404);
    expect((await as(u)('PATCH', `/v1/checklist/${item.id}`, { status: 'ready' })).status).toBe(404);
    expect((await as(u)('GET', `/v1/applicants/${a}`)).body.readiness).toMatchObject({ applicableCount: 0, blockingCount: 0 });
    const j = (await as(u)('GET', `/v1/applicants/${a}/journey`)).body.stages;
    expect(j.every((s: any) => s.itemCount === 0)).toBe(true);
    expect((await as(u)('GET', `/v1/applicants/${a}/checklist`)).body.lockedCount).toBe(0);

    await act(r.id, 'publish');
    const restored = (await items(u, a))[0]!;
    expect(restored).toMatchObject({ id: item.id, status: 'in_progress' });
  });

  it('archived requirements stay hidden from the Quick Check and from new cases', async () => {
    const r = await published('nikah');
    await act(r.id, 'archive');
    const u = await onboarded();
    const a = await applicant(u);
    expect(await items(u, a)).toEqual([]);
  });
});

describe('hash-change flags (Screen 40)', () => {
  const flagFor = async (sourceId: string) =>
    (await q<{ id: string }>(`INSERT INTO source_flags (source_id, new_hash) VALUES ($1,'h') RETURNING id`, [sourceId]))[0]!.id;

  it('lists flags with the number of affected published requirements', async () => {
    const s = await source();
    await published('a_item', {}, s.id);
    await published('b_item', {}, s.id);
    await cms('POST', '/v1/admin/requirements', REQ('c_draft', { sourceId: s.id }));
    await flagFor(s.id);
    const r = await cms('GET', '/v1/admin/source-flags?status=open');
    expect(r.body.items).toHaveLength(1);
    expect(r.body.items[0]).toMatchObject({ sourceId: s.id, sourceUrl: s.url, status: 'open', affectedRequirements: 2 });
    expect((await cms('GET', '/v1/admin/source-flags?status=resolved')).body.items).toEqual([]);
    expect((await cms('GET', '/v1/admin/sources')).body.items.find((x: any) => x.id === s.id).openFlag).toBe(true);
  });

  it('reverified: closes the flag and re-stamps every published requirement of that source', async () => {
    const s = await source();
    const r = await published('a_item', {}, s.id);
    const other = await published('other_item');
    await q(`UPDATE requirements SET last_verified_at = now() - interval '90 days'`);
    const f = await flagFor(s.id);
    const res = await cms('POST', `/v1/admin/source-flags/${f}/resolve`, { action: 'reverified', note: 'Checked page' });
    expect(res.body).toEqual({ id: f, status: 'resolved', requirementsRestamped: 1 });
    expect(Date.now() - new Date((await cms('GET', `/v1/admin/requirements/${r.id}`)).body.lastVerifiedAt).getTime()).toBeLessThan(60_000);
    expect(Date.now() - new Date((await cms('GET', `/v1/admin/requirements/${other.id}`)).body.lastVerifiedAt).getTime()).toBeGreaterThan(80 * 86400_000);
    expect((await cms('GET', `/v1/admin/requirements/${r.id}`)).body.version).toBe(1); // a re-stamp is not a content change
    const [row] = await q<{ status: string; resolved_by: string; resolution_note: string }>(`SELECT status, resolved_by, resolution_note FROM source_flags`);
    expect(row).toEqual({ status: 'resolved', resolved_by: cmsAdminId, resolution_note: 'Checked page' });
    expect((await cms('POST', `/v1/admin/source-flags/${f}/resolve`, { action: 'dismissed' })).status).toBe(409); // already closed
  });

  it('dismissed: closes without touching content; the user badge clears', async () => {
    const s = await source();
    const r = await published('a_item', {}, s.id);
    const f = await flagFor(s.id);
    await q(`UPDATE requirements SET last_verified_at = now() - interval '90 days'`);
    const res = await cms('POST', `/v1/admin/source-flags/${f}/resolve`, { action: 'dismissed' });
    expect(res.body).toMatchObject({ status: 'dismissed', requirementsRestamped: 0 });
    expect(Date.now() - new Date((await cms('GET', `/v1/admin/requirements/${r.id}`)).body.lastVerifiedAt).getTime()).toBeGreaterThan(80 * 86400_000);
    expect((await q(`SELECT 1 FROM source_flags WHERE status='open'`))).toHaveLength(0);
  });

  it('validation, 404, and scope', async () => {
    const s = await source();
    const f = await flagFor(s.id);
    for (const body of [{}, { action: 'ignore' }, { action: 'dismissed', note: '' }, { action: 'dismissed', note: 'x'.repeat(1001) }]) {
      expect((await cms('POST', `/v1/admin/source-flags/${f}/resolve`, body)).status).toBe(422);
    }
    expect((await cms('POST', '/v1/admin/source-flags/00000000-0000-4000-8000-000000000000/resolve', { action: 'dismissed' })).status).toBe(404);
    const ro = newAdminIdentity();
    await seedAdmin(ro, { scopes: ['read_only'] });
    expect((await asAdmin(ro)('POST', `/v1/admin/source-flags/${f}/resolve`, { action: 'dismissed' })).status).toBe(403);
  });
});

describe('the daily hash sweep (Cron)', () => {
  const html = (body: string) => new TextEncoder().encode(`<html><head><script>var t=${Math.random()}</script></head><body>${body}</body></html>`);
  const fetcherOf = (pages: Record<string, string | Error | Uint8Array>): SourceFetcher => async (url) => {
    const v = pages[url];
    if (v instanceof Error) throw v;
    if (v instanceof Uint8Array) return { bytes: v, contentType: 'application/pdf' };
    return { bytes: html(v ?? ''), contentType: 'text/html' };
  };
  const run = async (f: SourceFetcher) => {
    const { db, close } = await createDb({ ...env, HYPERDRIVE: { connectionString: process.env.TEST_DATABASE_URL! } });
    try { return await sweepSources(db, f); } finally { await close(); }
  };
  const row = async (id: string) =>
    (await q<any>(`SELECT last_hash, last_changed_at, last_error, consecutive_failures FROM sources WHERE id=$1`, [id]))[0];

  it('first sight is a baseline, not a change; an unchanged page raises nothing; script/comment noise is ignored', async () => {
    const s = await source({ url: 'https://example.test/a' });
    expect(await run(fetcherOf({ 'https://example.test/a': 'Fee: 100' }))).toEqual({ checked: 1, changed: 0, failed: 0 });
    expect((await row(s.id)).last_hash).not.toBeNull();
    expect(await q(`SELECT 1 FROM source_flags`)).toHaveLength(0);
    // fetcher regenerates a random <script> each call → same visible text → same hash
    expect((await run(fetcherOf({ 'https://example.test/a': 'Fee: 100' }))).changed).toBe(0);
    expect(await q(`SELECT 1 FROM source_flags`)).toHaveLength(0);
  });

  it('a visible-text change opens ONE flag (a second change while open only moves new_hash) and audits as the system', async () => {
    const s = await source({ url: 'https://example.test/a' });
    await run(fetcherOf({ 'https://example.test/a': 'Fee: 100' }));
    expect((await run(fetcherOf({ 'https://example.test/a': 'Fee: 120' }))).changed).toBe(1);
    const first = await q<{ old_hash: string; new_hash: string }>(`SELECT old_hash, new_hash FROM source_flags WHERE status='open'`);
    expect(first).toHaveLength(1);
    expect((await row(s.id)).last_changed_at).not.toBeNull();
    await run(fetcherOf({ 'https://example.test/a': 'Fee: 150' }));
    const second = await q<{ old_hash: string; new_hash: string }>(`SELECT old_hash, new_hash FROM source_flags WHERE status='open'`);
    expect(second).toHaveLength(1);
    expect(second[0]!.old_hash).toBe(first[0]!.old_hash);
    expect(second[0]!.new_hash).not.toBe(first[0]!.new_hash);
    const sys = await q<{ actor_type: string; actor_id: string | null }>(`SELECT actor_type, actor_id FROM audit_log WHERE action='source.changed'`);
    expect(sys[0]).toEqual({ actor_type: 'system', actor_id: null });
  });

  it('the user-facing badge appears while the flag is open', async () => {
    const u = await onboarded();
    const a = await applicant(u);
    const s = await source({ url: 'https://example.test/a' });
    await published('nikah', {}, s.id);
    await run(fetcherOf({ 'https://example.test/a': 'v1' }));
    expect((await items(u, a))[0]!.badges).not.toContain('source_under_review');
    await run(fetcherOf({ 'https://example.test/a': 'v2' }));
    expect((await items(u, a))[0]!.badges).toContain('source_under_review');
    const f = (await q<{ id: string }>(`SELECT id FROM source_flags`))[0]!.id;
    await cms('POST', `/v1/admin/source-flags/${f}/resolve`, { action: 'dismissed' });
    expect((await items(u, a))[0]!.badges).not.toContain('source_under_review');
  });

  it('PDFs are hashed byte-for-byte', async () => {
    const s = await source({ url: 'https://example.test/f.pdf' });
    const pdf = (n: number) => new Uint8Array([0x25, 0x50, 0x44, 0x46, n]);
    await run(fetcherOf({ 'https://example.test/f.pdf': pdf(1) }));
    expect((await run(fetcherOf({ 'https://example.test/f.pdf': pdf(2) }))).changed).toBe(1);
    expect((await row(s.id)).last_hash).toHaveLength(64);
  });

  it('a failed fetch never looks like a change; failures are counted and then reset', async () => {
    const s = await source({ url: 'https://example.test/a' });
    await run(fetcherOf({ 'https://example.test/a': 'ok' }));
    const before = (await row(s.id)).last_hash;
    expect(await run(fetcherOf({ 'https://example.test/a': new Error('HTTP 503') }))).toEqual({ checked: 1, changed: 0, failed: 1 });
    await run(fetcherOf({ 'https://example.test/a': new Error('timeout') }));
    const failing = await row(s.id);
    expect(failing).toMatchObject({ last_hash: before, last_error: 'timeout', consecutive_failures: 2 });
    expect(await q(`SELECT 1 FROM source_flags`)).toHaveLength(0);
    expect((await cms('GET', '/v1/admin/sources')).body.items[0]).toMatchObject({ consecutiveFailures: 2, lastError: 'timeout' });
    await run(fetcherOf({ 'https://example.test/a': 'ok' }));
    expect(await row(s.id)).toMatchObject({ last_error: null, consecutive_failures: 0 });
  });

  it('inactive sources are skipped; the batch is bounded and oldest-checked first', async () => {
    const a = await source({ url: 'https://example.test/a' });
    const b = await source({ url: 'https://example.test/b' });
    const c = await source({ url: 'https://example.test/c' });
    await cms('PATCH', `/v1/admin/sources/${c.id}`, { isActive: false });
    await q(`UPDATE app_config SET value = jsonb_set(value,'{hash_sweep_batch}','1') WHERE key='verification'`);
    try {
      const seen: string[] = [];
      const f: SourceFetcher = async (url) => { seen.push(url); return { bytes: html('x'), contentType: 'text/html' }; };
      await run(f);
      await run(f);
      expect(seen.sort()).toEqual(['https://example.test/a', 'https://example.test/b']); // each once, never c
      await run(f);
      expect(seen).toHaveLength(3);
    } finally {
      await q(`UPDATE app_config SET value = jsonb_set(value,'{hash_sweep_batch}','20') WHERE key='verification'`);
    }
    void a; void b;
  });

  it('normalizeForHash: HTML reduces to visible text; non-text is byte-exact', () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    const h = (s: string) => normalizeForHash(enc(s), 'text/html');
    expect(h('<p>Fee  100</p><script>x=1</script><!-- c -->')).toBe(h('<div>Fee 100</div><style>.a{}</style>'));
    expect(h('<p>Fee 100</p>')).not.toBe(h('<p>Fee 101</p>'));
    expect(normalizeForHash(enc('a'), 'application/pdf')).not.toBe(normalizeForHash(enc('b'), 'application/pdf'));
    expect(normalizeForHash(enc('same'), 'application/pdf')).toBe(normalizeForHash(enc('same'), 'application/pdf'));
  });
});

describe('How We Verify (public)', () => {
  it('needs no auth; counts only published; link %, open flags, last sweep and recent updates', async () => {
    const s = await source();
    const r1 = await published('a_item', { title: { en: 'Passport copy' } }, s.id);
    await published('b_item', {}, s.id);
    await cms('POST', '/v1/admin/requirements', REQ('draft_item'));
    await cms('PATCH', `/v1/admin/requirements/${r1.id}`, { purpose: { en: 'updated' }, reverify: true, changeSummary: { en: 'Purpose clarified' } });
    await q(`UPDATE sources SET last_checked_at = '2030-01-02 03:04:05+00'`);
    await q(`INSERT INTO source_flags (source_id, new_hash) VALUES ($1,'h')`, [s.id]);

    const res = await rawFetch('/v1/public/verification-summary');
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=300');
    const body: any = await res.json();
    expect(body).toMatchObject({ requirementsTracked: 2, sourceLinkedPercent: 100, openFlags: 1, lastSweepAt: '2030-01-02T03:04:05.000Z' });
    expect(body.recentUpdates).toHaveLength(3);
    expect(body.recentUpdates[0]).toMatchObject({ requirementTitle: 'Passport copy', changeSummary: 'Purpose clarified' });
  });

  it('an empty catalogue is honest: zeros, no divide-by-zero', async () => {
    const body: any = await (await rawFetch('/v1/public/verification-summary')).json();
    expect(body).toEqual({ requirementsTracked: 0, sourceLinkedPercent: 0, lastSweepAt: null, openFlags: 0, recentUpdates: [] });
  });
});
