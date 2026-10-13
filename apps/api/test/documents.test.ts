import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { as, call, env, login, newUser, SIGNING_KEY, store, type TestUser } from './helpers/app.js';
import { closePool, q, resetDb, seedCatalogue, seedLegal } from './helpers/db.js';
import { createDb } from '../src/db/client.js';
import { matchesMagic, purgeStaleDocuments } from '../src/modules/documents/documents.service.js';
import { signDocumentUrl, verifyDocumentUrl } from '../src/lib/signed-url.js';

beforeEach(async () => {
  await resetDb();
  store.objects.clear();
  store.failDeletes = false;
  await seedLegal();
  await seedCatalogue();
});
afterAll(closePool);

const PNG = (n = 64) => {
  const b = new Uint8Array(n);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return b;
};
const PDF = (n = 64) => {
  const b = new Uint8Array(n);
  b.set(new TextEncoder().encode('%PDF-1.7'));
  return b;
};
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

async function onboarded(): Promise<TestUser> {
  const id = (await q<{ id: string }>(`SELECT id FROM legal_versions WHERE is_current`))[0]!.id;
  const u = newUser();
  await login(u);
  await as(u)('POST', '/v1/legal/accept', { versionIds: [id] });
  return u;
}
async function applicant(u: TestUser, paid = false): Promise<string> {
  const r = await as(u)('POST', '/v1/applicants', {
    displayName: 'Ayesha', relationshipCode: 'wife', currentLocation: 'pakistan', currentStage: 'eligibility',
  });
  const id = r.body.applicant.id as string;
  if (paid) await q(`UPDATE applicants SET premium_status='active', access_until=now()+interval '30 days' WHERE id=$1`, [id]);
  return id;
}
const path = (url: string) => url.replace('http://t', '');

async function reserve(u: TestUser, applicantId: string, bytes: Uint8Array, mime = 'image/png', extra: object = {}) {
  return as(u)('POST', '/v1/documents/upload-url', {
    mime, sizeBytes: bytes.length, sha256: sha(bytes), applicantId, ...extra,
  });
}
async function put(url: string, bytes: Uint8Array, mime = 'image/png', lenOverride?: number) {
  return call('PUT', path(url), {
    bytes, headers: { 'Content-Length': String(lenOverride ?? bytes.length), 'Content-Type': mime },
  });
}
/** Full happy-path upload, returns the active document. */
async function upload(u: TestUser, applicantId: string, bytes = PNG(), mime = 'image/png', extra: object = {}) {
  const r = await reserve(u, applicantId, bytes, mime, extra);
  expect(r.status).toBe(200);
  expect((await put(r.body.uploadUrl, bytes, mime)).status).toBe(204);
  const c = await as(u)('POST', `/v1/documents/${r.body.id}/complete`);
  expect(c.status).toBe(200);
  return c.body;
}

describe('upload flow', () => {
  it('reserve → PUT → complete → metadata → signed view → bytes', async () => {
    const u = await onboarded();
    const a = await applicant(u);
    const bytes = PNG(100);
    const r = await reserve(u, a, bytes);
    expect(r.status).toBe(200);
    expect(r.body.requiredHeaders).toEqual({ 'Content-Type': 'image/png' });
    expect(r.body.uploadUrl).toMatch(/\/v1\/documents\/[0-9a-f-]{36}\/content\?exp=\d+&sig=[\w-]+$/);
    expect(new Date(r.body.expiresAt).getTime()).toBeGreaterThan(Date.now());

    expect((await put(r.body.uploadUrl, bytes)).status).toBe(204);
    const done = await as(u)('POST', `/v1/documents/${r.body.id}/complete`);
    expect(done.body).toMatchObject({
      id: r.body.id, applicantId: a, checklistItemId: null, mime: 'image/png', sizeBytes: 100, expiryDate: null, viewUrl: null,
    });

    const detail = await as(u)('GET', `/v1/documents/${r.body.id}`);
    expect(detail.body.viewUrl).toMatch(/\/content\?exp=\d+&sig=/);
    const view = await call('GET', path(detail.body.viewUrl));
    expect(view.status).toBe(200);
    expect(Array.from(view.bytes)).toEqual(Array.from(bytes));
    expect(view.headers.get('Content-Type')).toBe('image/png');
    expect(view.headers.get('Cache-Control')).toBe('private, no-store');
    expect(view.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it('complete is idempotent', async () => {
    const u = await onboarded();
    const a = await applicant(u);
    const doc = await upload(u, a);
    const again = await as(u)('POST', `/v1/documents/${doc.id}/complete`);
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(doc.id);
  });

  it('r2_key is server-generated and unguessable; no filename is stored', async () => {
    const u = await onboarded();
    const a = await applicant(u);
    const doc = await upload(u, a);
    const [row] = await q<{ r2_key: string }>(`SELECT r2_key FROM documents WHERE id=$1`, [doc.id]);
    expect(row!.r2_key).toMatch(/^u\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/);
    const cols = (await q<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name='documents'`)).map((c) => c.column_name);
    expect(cols.filter((c) => /name|file/.test(c))).toEqual([]);
  });

  it('PDF and an expiry date are accepted; expiry appears in the list', async () => {
    const u = await onboarded();
    const a = await applicant(u);
    const doc = await upload(u, a, PDF(), 'application/pdf', { expiryDate: '2030-01-31' });
    expect(doc.expiryDate).toBe('2030-01-31');
    expect((await as(u)('GET', '/v1/documents')).body.items[0].expiryDate).toBe('2030-01-31');
  });
});

describe('reserve validation', () => {
  it('422 on bad mime / sha / size / ids / date; 401 without a session', async () => {
    const u = await onboarded();
    const a = await applicant(u);
    const good = { mime: 'image/png', sizeBytes: 10, sha256: 'a'.repeat(64), applicantId: a };
    for (const patch of [
      { mime: 'application/x-msdownload' }, { mime: 'image/gif' }, { sha256: 'xyz' }, { sha256: 'A'.repeat(64) },
      { sizeBytes: 0 }, { sizeBytes: 1.5 }, { applicantId: 'nope' }, { checklistItemId: 'nope' }, { expiryDate: '31/01/2030' },
    ]) {
      expect((await as(u)('POST', '/v1/documents/upload-url', { ...good, ...patch })).status).toBe(422);
    }
    expect((await call('POST', '/v1/documents/upload-url', { body: good })).status).toBe(401);
  });

  it('per-file cap → 413 UPLOAD_TOO_LARGE, config-driven', async () => {
    const u = await onboarded();
    const a = await applicant(u);
    await q(`UPDATE app_config SET value = jsonb_set(value,'{max_file_bytes}','50') WHERE key='uploads'`);
    try {
      const r = await reserve(u, a, PNG(51));
      expect(r.status).toBe(413);
      expect(r.body.error.code).toBe('UPLOAD_TOO_LARGE');
      expect((await reserve(u, a, PNG(50))).status).toBe(200);
    } finally {
      await q(`UPDATE app_config SET value = jsonb_set(value,'{max_file_bytes}','10485760') WHERE key='uploads'`);
    }
  });

  it('a mime removed from config is refused', async () => {
    const u = await onboarded();
    const a = await applicant(u);
    await q(`UPDATE app_config SET value = jsonb_set(value,'{allowed_mimes}','["image/png"]') WHERE key='uploads'`);
    try {
      expect((await reserve(u, a, PDF(), 'application/pdf')).status).toBe(422);
    } finally {
      await q(`UPDATE app_config SET value = jsonb_set(value,'{allowed_mimes}','["image/jpeg","image/png","application/pdf"]') WHERE key='uploads'`);
    }
  });

  it('quota: active + live pending count; expired pending does not; 413 UPLOAD_QUOTA_EXCEEDED', async () => {
    const u = await onboarded();
    const a = await applicant(u);
    await q(`UPDATE app_config SET value = jsonb_set(value,'{max_bytes_per_user}','150') WHERE key='uploads'`);
    try {
      expect((await reserve(u, a, PNG(100))).status).toBe(200); // pending reserves 100
      const over = await reserve(u, a, PNG(100));
      expect(over.status).toBe(413);
      expect(over.body.error.code).toBe('UPLOAD_QUOTA_EXCEEDED');
      await q(`UPDATE documents SET created_at = now() - interval '1 hour'`); // URL no longer valid → releases
      expect((await reserve(u, a, PNG(100))).status).toBe(200);
    } finally {
      await q(`UPDATE app_config SET value = jsonb_set(value,'{max_bytes_per_user}','524288000') WHERE key='uploads'`);
    }
  });

  it('quota is per user', async () => {
    const a = await onboarded();
    const b = await onboarded();
    const aa = await applicant(a);
    const bb = await applicant(b);
    await q(`UPDATE app_config SET value = jsonb_set(value,'{max_bytes_per_user}','100') WHERE key='uploads'`);
    try {
      expect((await reserve(a, aa, PNG(100))).status).toBe(200);
      expect((await reserve(b, bb, PNG(100))).status).toBe(200);
    } finally {
      await q(`UPDATE app_config SET value = jsonb_set(value,'{max_bytes_per_user}','524288000') WHERE key='uploads'`);
    }
  });
});

describe('the bytes: capability URLs', () => {
  it('PUT needs a valid, unexpired, PUT-scoped signature — every failure is an opaque 404', async () => {
    const u = await onboarded();
    const a = await applicant(u);
    const bytes = PNG();
    const r = await reserve(u, a, bytes);
    const url = new URL(r.body.uploadUrl);
    const sig = url.searchParams.get('sig')!;
    const base = `/v1/documents/${r.body.id}/content`;
    const headers = { 'Content-Length': String(bytes.length), 'Content-Type': 'image/png' };

    for (const qs of [``, `?exp=1&sig=${sig}`, `?exp=${url.searchParams.get('exp')}&sig=${'A'.repeat(sig.length)}`, `?exp=${url.searchParams.get('exp')}&sig=!!`]) {
      const res = await call('PUT', base + qs, { bytes, headers });
      expect(res.status).toBe(404);
    }
    // a GET-scoped signature cannot be replayed as an upload, and vice versa
    const get = await signDocumentUrl(SIGNING_KEY, 'GET', r.body.id, 300);
    expect((await call('PUT', `${base}?exp=${get.exp}&sig=${get.sig}`, { bytes, headers })).status).toBe(404);
    // a signature for another document does not transfer
    const other = await signDocumentUrl(SIGNING_KEY, 'PUT', randomUUID(), 300);
    expect((await call('PUT', `${base}?exp=${other.exp}&sig=${other.sig}`, { bytes, headers })).status).toBe(404);
    // an expired one
    const old = await signDocumentUrl(SIGNING_KEY, 'PUT', r.body.id, 300, Date.now() - 3600_000);
    expect((await call('PUT', `${base}?exp=${old.exp}&sig=${old.sig}`, { bytes, headers })).status).toBe(404);
    expect(store.objects.size).toBe(0);
  });

  it('PUT refuses a body whose length or type differs from what was reserved', async () => {
    const u = await onboarded();
    const a = await applicant(u);
    const bytes = PNG(64);
    const r = await reserve(u, a, bytes);
    const wrongLen = await put(r.body.uploadUrl, PNG(65), 'image/png');
    expect(wrongLen.status).toBe(422);
    expect(wrongLen.body.error.code).toBe('UPLOAD_REJECTED');
    expect((await put(r.body.uploadUrl, bytes, 'application/pdf')).status).toBe(422);
    expect((await call('PUT', path(r.body.uploadUrl), { headers: { 'Content-Length': '64', 'Content-Type': 'image/png' } })).status).toBe(422);
    expect(store.objects.size).toBe(0);
  });

  it('an upload URL stops working once the document is active; a GET URL needs an active document', async () => {
    const u = await onboarded();
    const a = await applicant(u);
    const bytes = PNG();
    const r = await reserve(u, a, bytes);
    // not active yet → no view
    const early = await signDocumentUrl(SIGNING_KEY, 'GET', r.body.id, 300);
    expect((await call('GET', `/v1/documents/${r.body.id}/content?exp=${early.exp}&sig=${early.sig}`)).status).toBe(404);
    await put(r.body.uploadUrl, bytes);
    await as(u)('POST', `/v1/documents/${r.body.id}/complete`);
    expect((await put(r.body.uploadUrl, bytes)).status).toBe(404); // replay after activation
    expect((await call('GET', `/v1/documents/${r.body.id}/content?exp=${early.exp}&sig=${early.sig}`)).status).toBe(200);
  });
});

describe('complete verifies what actually landed', () => {
  it('nothing uploaded → 422 UPLOAD_REJECTED, stays pending (client may still upload)', async () => {
    const u = await onboarded();
    const a = await applicant(u);
    const r = await reserve(u, a, PNG());
    const c = await as(u)('POST', `/v1/documents/${r.body.id}/complete`);
    expect(c.status).toBe(422);
    expect(c.body.error.code).toBe('UPLOAD_REJECTED');
    expect((await q<{ status: string }>(`SELECT status FROM documents`))[0]!.status).toBe('pending');
  });

  it('wrong magic bytes (e.g. an .exe declared as PNG) → rejected, object and reservation discarded', async () => {
    const u = await onboarded();
    const a = await applicant(u);
    const evil = new Uint8Array(64);
    evil.set([0x4d, 0x5a]); // MZ
    const r = await reserve(u, a, evil);
    await put(r.body.uploadUrl, evil);
    expect(store.objects.size).toBe(1);
    const c = await as(u)('POST', `/v1/documents/${r.body.id}/complete`);
    expect(c.body.error.code).toBe('UPLOAD_REJECTED');
    expect(store.objects.size).toBe(0);
    expect((await q<{ status: string }>(`SELECT status FROM documents`))[0]!.status).toBe('deleted');
    expect((await as(u)('GET', '/v1/documents')).body.items).toEqual([]);
  });

  it('object size differs from the declared size → rejected and discarded', async () => {
    const u = await onboarded();
    const a = await applicant(u);
    const r = await reserve(u, a, PNG(64));
    const [d] = await q<{ r2_key: string }>(`SELECT r2_key FROM documents`);
    await store.put(d!.r2_key, PNG(70), 'image/png'); // bypassed the length check
    expect((await as(u)('POST', `/v1/documents/${r.body.id}/complete`)).status).toBe(422);
    expect(store.objects.size).toBe(0);
  });

  it('quota is re-checked at complete', async () => {
    const u = await onboarded();
    const a = await applicant(u);
    const r = await reserve(u, a, PNG(100));
    await put(r.body.uploadUrl, PNG(100));
    await q(`UPDATE app_config SET value = jsonb_set(value,'{max_bytes_per_user}','50') WHERE key='uploads'`);
    try {
      const c = await as(u)('POST', `/v1/documents/${r.body.id}/complete`);
      expect(c.body.error.code).toBe('UPLOAD_QUOTA_EXCEEDED');
      expect(store.objects.size).toBe(0);
    } finally {
      await q(`UPDATE app_config SET value = jsonb_set(value,'{max_bytes_per_user}','524288000') WHERE key='uploads'`);
    }
  });
});

describe('checklist integration', () => {
  it('linking: documentCount and item detail list it; foreign / N/A / locked items refused', async () => {
    const u = await onboarded();
    const a = await applicant(u, true);
    const items = (await as(u)('GET', `/v1/applicants/${a}/checklist?limit=50`)).body.items as any[];
    const passport = items.find((i) => i.requirementCode === 'passport');
    const na = items.find((i) => i.status === 'not_applicable');

    const doc = await upload(u, a, PNG(), 'image/png', { checklistItemId: passport.id });
    expect(doc.checklistItemId).toBe(passport.id);
    const detail = await as(u)('GET', `/v1/checklist/${passport.id}`);
    expect(detail.body.documentCount).toBe(1);
    expect(detail.body.documents.map((d: any) => d.id)).toEqual([doc.id]);
    expect(detail.body.documents[0].viewUrl).toBeNull();
    expect((await as(u)('GET', `/v1/applicants/${a}/checklist`)).body.items.find((i: any) => i.id === passport.id).documentCount).toBe(1);

    const naRes = await reserve(u, a, PNG(), 'image/png', { checklistItemId: na.id });
    expect(naRes.status).toBe(409);
    expect((await reserve(u, a, PNG(), 'image/png', { checklistItemId: randomUUID() })).status).toBe(404);

    // another user's item, even paired with my own applicant → 404
    const other = await onboarded();
    const oa = await applicant(other, true);
    const oi = (await as(other)('GET', `/v1/applicants/${oa}/checklist`)).body.items[0];
    expect((await reserve(u, a, PNG(), 'image/png', { checklistItemId: oi.id })).status).toBe(404);
    // my item paired with a different applicant of mine → 404
    const a2 = await as(u)('POST', '/v1/applicants', { displayName: 'Z', relationshipCode: 'wife', currentLocation: 'pakistan', currentStage: 'eligibility' });
    expect((await reserve(u, a2.body.applicant.id, PNG(), 'image/png', { checklistItemId: passport.id })).status).toBe(404);
  });

  it('free tier: cannot attach to a locked item (402) but can upload unlinked', async () => {
    const u = await onboarded();
    const a = await applicant(u); // free
    const locked = (await q<{ id: string }>(
      `SELECT ar.id FROM applicant_requirements ar JOIN requirements r ON r.id=ar.requirement_id WHERE r.code='appointment_slot'`))[0]!.id;
    const r = await reserve(u, a, PNG(), 'image/png', { checklistItemId: locked });
    expect(r.status).toBe(402);
    expect(r.body.error.code).toBe('PREMIUM_REQUIRED');
    expect((await reserve(u, a, PNG())).status).toBe(200);
  });

  it('deleting a document drops it from the item', async () => {
    const u = await onboarded();
    const a = await applicant(u, true);
    const passport = (await as(u)('GET', `/v1/applicants/${a}/checklist`)).body.items[0];
    const doc = await upload(u, a, PNG(), 'image/png', { checklistItemId: passport.id });
    await as(u)('DELETE', `/v1/documents/${doc.id}`);
    expect((await as(u)('GET', `/v1/checklist/${passport.id}`)).body.documentCount).toBe(0);
  });
});

describe('access levels (PRD §7)', () => {
  it('grace: reads work, reserve/complete/delete → 403 APPLICANT_READ_ONLY', async () => {
    const u = await onboarded();
    const a = await applicant(u);
    const doc = await upload(u, a);
    const pending = await reserve(u, a, PNG());
    await q(`UPDATE applicants SET premium_status='expired_pending_confirmation', grace_until=now()+interval '5 days'`);
    expect((await as(u)('GET', '/v1/documents')).body.items).toHaveLength(1);
    expect((await as(u)('GET', `/v1/documents/${doc.id}`)).status).toBe(200);
    for (const r of [
      await reserve(u, a, PNG()),
      await as(u)('POST', `/v1/documents/${pending.body.id}/complete`),
      await as(u)('DELETE', `/v1/documents/${doc.id}`),
    ]) {
      expect(r.status).toBe(403);
      expect(r.body.error.code).toBe('APPLICANT_READ_ONLY');
    }
    expect(store.objects.size).toBe(1);
  });
});

describe('list + delete', () => {
  it('lists newest first with a keyset cursor, filters by applicant, reports quota', async () => {
    const u = await onboarded();
    const a = await applicant(u);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await upload(u, a, PNG(64 + i))).id);
    const p1 = await as(u)('GET', '/v1/documents?limit=2');
    expect(p1.body.items.map((d: any) => d.id)).toEqual([ids[2], ids[1]]);
    expect(p1.body.nextCursor).not.toBeNull();
    expect(p1.body.quota).toEqual({ usedBytes: 64 + 65 + 66, maxBytes: 524288000 });
    const p2 = await as(u)('GET', `/v1/documents?limit=2&cursor=${p1.body.nextCursor}`);
    expect(p2.body.items.map((d: any) => d.id)).toEqual([ids[0]]);
    expect(p2.body.nextCursor).toBeNull();
    expect((await as(u)('GET', `/v1/documents?applicantId=${randomUUID()}`)).body.items).toEqual([]);
    for (const qs of ['cursor=@@', 'limit=0', 'limit=51', 'applicantId=x']) {
      expect((await as(u)('GET', `/v1/documents?${qs}`)).status).toBe(422);
    }
  });

  it('delete removes the R2 object then the row; viewing afterwards is 404', async () => {
    const u = await onboarded();
    const a = await applicant(u);
    const doc = await upload(u, a);
    const view = (await as(u)('GET', `/v1/documents/${doc.id}`)).body.viewUrl as string;
    expect((await as(u)('DELETE', `/v1/documents/${doc.id}`)).status).toBe(204);
    expect(store.objects.size).toBe(0);
    expect((await as(u)('GET', `/v1/documents/${doc.id}`)).status).toBe(404);
    expect((await call('GET', path(view))).status).toBe(404);
    expect((await as(u)('DELETE', `/v1/documents/${doc.id}`)).status).toBe(404);
  });

  it('if R2 fails the row survives and the delete can be retried', async () => {
    const u = await onboarded();
    const a = await applicant(u);
    const doc = await upload(u, a);
    store.failDeletes = true;
    expect((await as(u)('DELETE', `/v1/documents/${doc.id}`)).status).toBe(500);
    expect((await q<{ status: string }>(`SELECT status FROM documents`))[0]!.status).toBe('active');
    store.failDeletes = false;
    expect((await as(u)('DELETE', `/v1/documents/${doc.id}`)).status).toBe(204);
    expect(store.objects.size).toBe(0);
  });
});

describe('ownership — cross-user 404 on every verb (Gate 3, mandatory)', () => {
  it("B gets 404 for A's document on complete / get / delete / list, and cannot reserve against A's applicant", async () => {
    const a = await onboarded();
    const b = await onboarded();
    const aa = await applicant(a);
    await applicant(b);
    const doc = await upload(a, aa);
    const pending = await reserve(a, aa, PNG());

    for (const r of [
      await as(b)('GET', `/v1/documents/${doc.id}`),
      await as(b)('DELETE', `/v1/documents/${doc.id}`),
      await as(b)('POST', `/v1/documents/${pending.body.id}/complete`),
      await reserve(b, aa, PNG()),
    ]) {
      expect(r.status).toBe(404);
      expect(r.body.error.code).toBe('NOT_FOUND');
    }
    expect((await as(b)('GET', '/v1/documents')).body.items).toEqual([]);
    expect((await as(b)('GET', `/v1/documents?applicantId=${aa}`)).body.items).toEqual([]);
    expect((await as(b)('GET', `/v1/documents/${randomUUID()}`)).body.error.message).toBe(
      (await as(b)('GET', `/v1/documents/${doc.id}`)).body.error.message,
    );
    expect(store.objects.size).toBe(1);
    expect((await as(a)('GET', `/v1/documents/${doc.id}`)).status).toBe(200);
  });

  it('401 without a session; 422 for non-uuid ids', async () => {
    const u = await onboarded();
    expect((await call('GET', '/v1/documents')).status).toBe(401);
    expect((await call('DELETE', `/v1/documents/${randomUUID()}`)).status).toBe(401);
    expect((await as(u)('GET', '/v1/documents/nope')).status).toBe(422);
  });
});

describe('retention (Cron)', () => {
  it('abandoned pending uploads lose their object; old deleted rows are purged; fresh ones are kept', async () => {
    const u = await onboarded();
    const a = await applicant(u);
    const abandoned = await reserve(u, a, PNG());
    await put(abandoned.body.uploadUrl, PNG());
    const fresh = await reserve(u, a, PNG());
    const dead = await upload(u, a);
    await as(u)('DELETE', `/v1/documents/${dead.id}`);
    await q(`UPDATE documents SET created_at = now() - interval '1 day' WHERE id=$1`, [abandoned.body.id]);
    await q(`UPDATE documents SET deleted_at = now() - interval '31 days' WHERE id=$1`, [dead.id]);

    const { db, close } = await createDb(env.HYPERDRIVE ? { ...env, HYPERDRIVE: { connectionString: process.env.TEST_DATABASE_URL! } } : env);
    try {
      const out = await purgeStaleDocuments(db, store);
      expect(out.abandoned).toBe(1);
      expect(out.purged).toBeGreaterThanOrEqual(1);
    } finally {
      await close();
    }
    const left = await q<{ id: string; status: string }>(`SELECT id, status FROM documents ORDER BY created_at`);
    expect(left.find((d) => d.id === dead.id)).toBeUndefined(); // purged
    expect(left.find((d) => d.id === abandoned.body.id)!.status).toBe('deleted'); // soft-deleted, kept 30 days
    expect(left.find((d) => d.id === fresh.body.id)!.status).toBe('pending'); // still valid
    expect(store.objects.size).toBe(0);
  });
});

describe('units', () => {
  it('magic numbers', () => {
    expect(matchesMagic('image/png', PNG())).toBe(true);
    expect(matchesMagic('image/jpeg', new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe(true);
    expect(matchesMagic('application/pdf', PDF())).toBe(true);
    expect(matchesMagic('image/png', PDF())).toBe(false);
    expect(matchesMagic('image/png', new Uint8Array([0x89, 0x50]))).toBe(false); // truncated
    expect(matchesMagic('text/html', new TextEncoder().encode('<html>'))).toBe(false);
  });

  it('signed URLs: round trip, method/id/exp binding, tamper, expiry, malformed', async () => {
    const { exp, sig } = await signDocumentUrl(SIGNING_KEY, 'GET', 'doc-1', 60);
    const v = (m: 'GET' | 'PUT', id: string, e: string | undefined, s: string | undefined, now?: number) =>
      verifyDocumentUrl(SIGNING_KEY, m, id, e, s, now);
    expect(await v('GET', 'doc-1', String(exp), sig)).toBe(true);
    expect(await v('PUT', 'doc-1', String(exp), sig)).toBe(false);
    expect(await v('GET', 'doc-2', String(exp), sig)).toBe(false);
    expect(await v('GET', 'doc-1', String(exp + 1), sig)).toBe(false);
    expect(await v('GET', 'doc-1', String(exp), sig.slice(0, -2) + 'AA')).toBe(false);
    expect(await v('GET', 'doc-1', String(exp), sig, (exp + 1) * 1000)).toBe(false);
    expect(await v('GET', 'doc-1', undefined, sig)).toBe(false);
    expect(await v('GET', 'doc-1', 'abc', sig)).toBe(false);
    expect(await v('GET', 'doc-1', String(exp), '')).toBe(false);
    expect(await verifyDocumentUrl('another-key-another-key-another-key-xx', 'GET', 'doc-1', String(exp), sig)).toBe(false);
  });
});
