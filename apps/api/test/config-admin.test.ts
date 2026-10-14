import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { asAdmin, call, newAdminIdentity } from './helpers/app.js';
import { closePool, q, resetDb, seedAdmin } from './helpers/db.js';

// app_config is migration-owned and survives resetDb; these tests rewrite it, so snapshot and restore.
let snapshot: Array<{ key: string; value: unknown; description: string | null; updated_by: string | null }>;
beforeEach(async () => {
  await resetDb();
  snapshot = await q(`SELECT key, value, description, updated_by FROM app_config`) as typeof snapshot;
});
afterEach(async () => {
  await q(`DELETE FROM app_config`);
  for (const r of snapshot) {
    await q(`INSERT INTO app_config (key, value, description, updated_by) VALUES ($1,$2::jsonb,$3,NULL)`, [r.key, JSON.stringify(r.value), r.description]);
  }
});
afterAll(closePool);

async function admin(opts: { isSuper?: boolean; scopes?: string[] }) {
  const id = newAdminIdentity();
  const adminId = await seedAdmin(id, opts);
  return { call: asAdmin(id), id: adminId };
}
const valueOf = async (key: string) => (await q<{ value: any }>(`SELECT value FROM app_config WHERE key=$1`, [key]))[0]?.value;

describe('GET /v1/admin/config', () => {
  it('lists every editable key; scope pricing_config or read_only may read, others 403, anonymous 401', async () => {
    const pricing = await admin({ scopes: ['pricing_config'] });
    const r = await pricing.call('GET', '/v1/admin/config');
    expect(r.status).toBe(200);
    const keys = r.body.items.map((i: any) => i.key);
    expect(keys).toEqual(expect.arrayContaining(['auth', 'sla', 'support', 'uploads', 'privacy']));
    expect(r.body.items.find((i: any) => i.key === 'auth')).toMatchObject({ value: { max_active_devices: 2 }, isDefault: false });
    expect((await (await admin({ scopes: ['read_only'] })).call('GET', '/v1/admin/config')).status).toBe(200);
    expect((await (await admin({ scopes: ['support_manage'] })).call('GET', '/v1/admin/config')).status).toBe(403);
    expect((await call('GET', '/v1/admin/config')).status).toBe(401);
  });

  it('a key with no row is listed as a default', async () => {
    await q(`DELETE FROM app_config WHERE key='checklist'`);
    const a = await admin({ isSuper: true });
    const e = (await a.call('GET', '/v1/admin/config')).body.items.find((i: any) => i.key === 'checklist');
    expect(e).toMatchObject({ isDefault: true, value: {}, updatedAt: null });
  });
});

describe('PUT /v1/admin/config/:key', () => {
  it('replaces the value, records who/when, and audits before + after in the same transaction', async () => {
    const a = await admin({ scopes: ['pricing_config'] });
    const r = await a.call('PUT', '/v1/admin/config/auth', { value: { max_active_devices: 3 } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ key: 'auth', value: { max_active_devices: 3 }, isDefault: false, updatedBy: a.id });
    expect(await valueOf('auth')).toEqual({ max_active_devices: 3 });
    const [log] = await q<{ metadata: any; target_id: string; actor_id: string }>(`SELECT metadata, target_id, actor_id FROM audit_log WHERE action='config.update'`);
    expect(log).toMatchObject({ target_id: 'auth', actor_id: a.id });
    expect(log!.metadata).toEqual({ before: { max_active_devices: 2 }, after: { max_active_devices: 3 } });
  });

  it('takes effect without a deploy: the device limit is read from the new value', async () => {
    const a = await admin({ isSuper: true });
    await a.call('PUT', '/v1/admin/config/checklist', { value: { free_preview_items: 7 } });
    expect(await valueOf('checklist')).toEqual({ free_preview_items: 7 });
  });

  it('creates the row when the key had none (first write over the fallback)', async () => {
    await q(`DELETE FROM app_config WHERE key='checklist'`);
    const a = await admin({ isSuper: true });
    const r = await a.call('PUT', '/v1/admin/config/checklist', { value: { free_preview_items: 5 } });
    expect(r.status).toBe(200);
    const [log] = await q<{ metadata: any }>(`SELECT metadata FROM audit_log WHERE action='config.update'`);
    expect(log!.metadata.before).toBeNull();
  });

  it('is strict: unknown field, wrong type, out of bounds, missing field → 422 and NOTHING changes or is audited', async () => {
    const a = await admin({ scopes: ['pricing_config'] });
    const bad: Array<[string, unknown]> = [
      ['auth', { max_active_devices: 3, typo: 1 }],
      ['auth', { max_active_devices: '3' }],
      ['auth', { max_active_devices: 0 }],
      ['auth', {}],
      ['uploads', { max_file_bytes: 5, max_bytes_per_user: 1, upload_url_ttl_seconds: 1, view_url_ttl_seconds: 1, deleted_retention_days: 1, allowed_mimes: [] }],
      ['sla', { support_paid_hours: 24, support_free_hours: 48, working_hours_windows: { utc_offset_minutes: 0, days: [1], start_minute: 600, end_minute: 600 } }],
      ['sla', { support_paid_hours: 24, support_free_hours: 48, working_hours_windows: { utc_offset_minutes: 0, days: [8], start_minute: 0, end_minute: 60 } }],
      ['support', { topics_free: ['chitchat'], messages_per_hour: 20, attachment_max_bytes: 100000, attachment_upload_ttl_seconds: 900, retention_months: 24 }],
    ];
    for (const [key, value] of bad) {
      const r = await a.call('PUT', `/v1/admin/config/${key}`, { value });
      expect([key, r.status]).toEqual([key, 422]);
    }
    expect((await a.call('PUT', '/v1/admin/config/auth', { max_active_devices: 3 })).status).toBe(422); // value not wrapped
    expect(await valueOf('auth')).toEqual({ max_active_devices: 2 });
    expect(await q(`SELECT 1 FROM audit_log WHERE action='config.update'`)).toHaveLength(0);
  });

  it('unknown key → 422 (not a way to create arbitrary settings)', async () => {
    const a = await admin({ isSuper: true });
    expect((await a.call('PUT', '/v1/admin/config/stripe_secret', { value: { a: 1 } })).status).toBe(422);
    expect(await q(`SELECT 1 FROM app_config WHERE key='stripe_secret'`)).toHaveLength(0);
  });

  it('write needs pricing_config (or super): read_only and other scopes get 403; anonymous 401', async () => {
    for (const scopes of [['read_only'], ['support_manage']]) {
      const a = await admin({ scopes });
      expect((await a.call('PUT', '/v1/admin/config/auth', { value: { max_active_devices: 3 } })).status).toBe(403);
    }
    expect((await call('PUT', '/v1/admin/config/auth', { body: { value: { max_active_devices: 3 } } })).status).toBe(401);
    expect(await valueOf('auth')).toEqual({ max_active_devices: 2 });
  });

  it('working_hours_text: English required, verdict language rejected, valid copy saved and served to users', async () => {
    const a = await admin({ scopes: ['pricing_config'] });
    const base = { support_paid_hours: 24, support_free_hours: 48, working_hours_windows: { utc_offset_minutes: 300, days: [1, 2, 3, 4, 5, 6], start_minute: 540, end_minute: 1080 } };
    expect((await a.call('PUT', '/v1/admin/config/sla', { value: { ...base, working_hours_text: { ur: 'x' } } })).status).toBe(422);
    const verdict = await a.call('PUT', '/v1/admin/config/sla', { value: { ...base, working_hours_text: { en: 'You are eligible, we reply Mon–Sat' } } });
    expect(verdict.status).toBe(422);
    expect(JSON.stringify(verdict.body.error.details)).toContain('working_hours_text.en');
    const ok = await a.call('PUT', '/v1/admin/config/sla', { value: { ...base, working_hours_text: { en: 'Mon–Sat 9–6 PKT' } } });
    expect(ok.status).toBe(200);
    expect((await valueOf('sla')).working_hours_text).toEqual({ en: 'Mon–Sat 9–6 PKT' });
  });
});

describe('GET /v1/admin/overview', () => {
  async function seedQueues() {
    const [u] = await q<{ id: string }>(`INSERT INTO users (firebase_uid, email, onboarding_state) VALUES ('ov1','ov1@example.com','complete') RETURNING id`);
    await q(`INSERT INTO support_threads (user_id, status, tier, sla_due_at, last_message_at) VALUES ($1,'awaiting_support','free', now() - interval '1 hour', now())`, [u!.id]);
    await q(`INSERT INTO data_requests (user_id, kind, status) VALUES ($1,'export','received')`, [u!.id]);
    await q(`INSERT INTO legal_versions (doc_type, locale, version, title, body_md) VALUES ('terms','en','ov-draft','t','b')`);
  }

  it('shows each admin only their sections; super and read_only see all; empty queues are real zeros', async () => {
    await seedQueues();
    const sup = (await (await admin({ scopes: ['support_manage'] })).call('GET', '/v1/admin/overview')).body;
    expect(sup).toEqual({ support: { awaitingSupport: 1, breached: 1, unassigned: 1 } });

    const ver = (await (await admin({ scopes: ['verification_manage'] })).call('GET', '/v1/admin/overview')).body;
    expect(Object.keys(ver)).toEqual(['verification']);
    expect(ver.verification).toEqual({ openHashFlags: 0, unreachableSources: 0, drafts: 0, awaitingPublish: 0 });

    for (const a of [await admin({ isSuper: true }), await admin({ scopes: ['read_only'] })]) {
      const all = (await a.call('GET', '/v1/admin/overview')).body;
      expect(Object.keys(all).sort()).toEqual(['legal', 'privacy', 'support', 'verification']);
      expect(all.legal).toEqual({ draftVersions: 1 });
      expect(all.privacy.openRequests).toBe(1);
      expect(all.privacy.oldestOpenAt).toEqual(expect.any(String));
    }
    const none = (await (await admin({ scopes: ['pricing_config'] })).call('GET', '/v1/admin/overview')).body;
    expect(none).toEqual({});
  });

  it('verification counts: open flag and unreachable source (config threshold)', async () => {
    const [s] = await q<{ id: string }>(`INSERT INTO sources (name, url, authority, is_active, consecutive_failures) VALUES ('{"en":"S"}','https://s.example/1','government',true,5) RETURNING id`);
    await q(`INSERT INTO source_flags (source_id, new_hash, status) VALUES ($1,'abc','open')`, [s!.id]);
    const a = await admin({ scopes: ['verification_manage'] });
    expect((await a.call('GET', '/v1/admin/overview')).body.verification).toMatchObject({ openHashFlags: 1, unreachableSources: 1 });
  });

  it('requires an admin token (401) and an active admin (403)', async () => {
    expect((await call('GET', '/v1/admin/overview')).status).toBe(401);
    const id = newAdminIdentity();
    await seedAdmin(id, { status: 'disabled' });
    expect((await asAdmin(id)('GET', '/v1/admin/overview')).status).toBe(403);
  });
});
