import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { as, asAdmin, call, env, login, newAdminIdentity, newUser, store, type TestUser } from './helpers/app.js';
import { closePool, q, resetDb, seedAdmin, seedCatalogue, seedLegal, seedTemplates } from './helpers/db.js';
import { createDb } from '../src/db/client.js';
import { notify } from '../src/modules/notifications/notifications.service.js';
import { refreshNextActions } from '../src/modules/today/today.service.js';

/**
 * Golden JSON for the Flutter screens built on the checklist, documents, Today, notifications, support,
 * privacy and public endpoints. REAL handler output — see mobile-fixtures.test.ts for the purpose and command:
 *
 *   MOBILE_FIXTURES_DIR=../mobile/test/fixtures pnpm test test/mobile-fixtures
 */
const dir = process.env.MOBILE_FIXTURES_DIR;
const out = (name: string, body: unknown) => {
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.json`), JSON.stringify(body, null, 2) + '\n');
};

beforeEach(async () => {
  await resetDb();
  store.objects.clear();
  await seedCatalogue();
  await seedTemplates();
});
afterAll(closePool);

const PNG = (n = 64) => {
  const b = new Uint8Array(n);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return b;
};

async function onboardedWithCase(paid: boolean): Promise<{ u: TestUser; applicantId: string }> {
  const { disclaimerId } = await seedLegal();
  const u = newUser();
  await login(u);
  await as(u)('POST', '/v1/legal/accept', { versionIds: [disclaimerId] });
  const r = await as(u)('POST', '/v1/applicants', { displayName: 'Ayesha', relationshipCode: 'wife', currentLocation: 'pakistan', currentStage: 'documents' });
  const applicantId = r.body.applicant.id as string;
  if (paid) await q(`UPDATE applicants SET premium_status='active', access_until=now()+interval '30 days' WHERE id=$1`, [applicantId]);
  return { u, applicantId };
}

async function withDb<T>(fn: (db: Awaited<ReturnType<typeof createDb>>['db']) => Promise<T>): Promise<T> {
  const { db, close } = await createDb({ ...env, HYPERDRIVE: { connectionString: process.env.TEST_DATABASE_URL! } });
  try { return await fn(db); } finally { await close(); }
}

describe('mobile UI fixtures', () => {
  it('free applicant: locked checklist', async () => {
    const { u, applicantId } = await onboardedWithCase(false);
    const list = await as(u)('GET', `/v1/applicants/${applicantId}/checklist`);
    expect(list.body.lockedCount).toBeGreaterThan(0);
    out('checklist_free', list.body);
    const locked = await q<{ id: string }>(`SELECT ar.id FROM applicant_requirements ar JOIN requirements r ON r.id=ar.requirement_id WHERE ar.applicant_id=$1 AND r.code='visa_form'`, [applicantId]);
    const d = await as(u)('GET', `/v1/checklist/${locked[0]!.id}`);
    expect(d.status).toBe(402);
    out('error_premium_required', d.body);
  });

  it('premium applicant: checklist, detail, journey, patch, documents, today', async () => {
    const { u, applicantId } = await onboardedWithCase(true);
    const list = await as(u)('GET', `/v1/applicants/${applicantId}/checklist?limit=50`);
    expect(list.status).toBe(200);
    out('checklist_premium', list.body);
    out('checklist_filtered_blocking', (await as(u)('GET', `/v1/applicants/${applicantId}/checklist?blocking=true`)).body);
    out('journey', (await as(u)('GET', `/v1/applicants/${applicantId}/journey`)).body);

    const nikah = list.body.items.find((i: any) => i.requirementCode === 'nikah');
    await q(`UPDATE requirements SET purpose='{"en":"Proof of marriage"}', who_provides='{"en":"Applicant"}', where_to_obtain='{"en":"Union council"}', recommended_timing='{"en":"Early"}' WHERE code='nikah'`);
    await q(`UPDATE requirements SET last_verified_at = now() - interval '12 days' WHERE code='nikah'`);
    const detail = await as(u)('GET', `/v1/checklist/${nikah.id}`);
    expect(detail.status).toBe(200);
    out('checklist_item_detail', detail.body);
    const na = list.body.items.find((i: any) => i.status === 'not_applicable');
    if (na) out('checklist_item_not_applicable', (await as(u)('GET', `/v1/checklist/${na.id}`)).body);

    const patched = await as(u)('PATCH', `/v1/checklist/${nikah.id}`, { status: 'in_progress' });
    expect(patched.status).toBe(200);
    out('checklist_item_patched', patched.body);

    // documents: reserve → PUT → complete, linked to the item
    const bytes = PNG(100);
    const sha = createHash('sha256').update(bytes).digest('hex');
    const r = await as(u)('POST', '/v1/documents/upload-url', { mime: 'image/png', sizeBytes: bytes.length, sha256: sha, applicantId, checklistItemId: nikah.id });
    expect(r.status).toBe(200);
    out('document_upload_url', r.body);
    expect((await call('PUT', r.body.uploadUrl.replace('http://t', ''), { bytes, headers: { 'Content-Length': String(bytes.length), 'Content-Type': 'image/png' } })).status).toBe(204);
    const done = await as(u)('POST', `/v1/documents/${r.body.id}/complete`);
    out('document_complete', done.body);
    out('documents_list', (await as(u)('GET', '/v1/documents')).body);
    out('document_detail', (await as(u)('GET', `/v1/documents/${r.body.id}`)).body);

    await withDb((db) => refreshNextActions(db));
    const today = await as(u)('GET', '/v1/today');
    expect(today.body.actions.length).toBeGreaterThan(0);
    out('today_actions', today.body);
    // all clear: mark everything ready
    await q(`UPDATE applicant_requirements SET status='ready' WHERE applicant_id=$1`, [applicantId]);
    await q(`UPDATE next_actions SET computed_at = now() - interval '1 hour'`);
    await withDb((db) => refreshNextActions(db));
    out('today_all_clear', (await as(u)('GET', '/v1/today')).body);
  });

  it('free account: Today is premium-only', async () => {
    const { u } = await onboardedWithCase(false);
    const t = await as(u)('GET', '/v1/today');
    expect(t.status).toBe(402);
    out('error_premium_required_today', t.body);
  });

  it('notifications: inbox, unread count, preferences', async () => {
    const { u, applicantId } = await onboardedWithCase(true);
    const uid = (await q<{ id: string }>(`SELECT id FROM users WHERE firebase_uid=$1`, [u.uid]))[0]!.id;
    await withDb(async (db) => {
      await notify(db, { userId: uid, type: 'requirement_changed', deepLink: `/applicants/${applicantId}`, applicantId, dedupeKey: 'fx1', vars: { title: 'Nikah certificate', changeSummary: 'Attestation now required' } });
    });
    const list = await as(u)('GET', '/v1/notifications?tab=activity');
    const upd = await as(u)('GET', '/v1/notifications?tab=update');
    out('notifications_activity', list.body);
    out('notifications_update', upd.body);
    out('notifications_empty_reminder', (await as(u)('GET', '/v1/notifications?tab=reminder')).body);
    out('notifications_unread_count', (await as(u)('GET', '/v1/notifications/unread-count')).body);
    out('notification_preferences', (await as(u)('GET', '/v1/notification-preferences')).body);
  });

  it('support: empty thread, then a conversation with an admin reply', async () => {
    const { u } = await onboardedWithCase(false);
    out('support_thread_none', (await as(u)('GET', '/v1/support/thread')).body);
    const sent = await as(u)('POST', '/v1/support/messages', { body: 'What does Premium include?', topic: 'presales' });
    expect(sent.status).toBe(201);
    out('support_message_sent', sent.body);
    const opsId = newAdminIdentity();
    await seedAdmin(opsId, { scopes: ['support_manage'] });
    const tid = (await q<{ id: string }>(`SELECT id FROM support_threads`))[0]!.id;
    const reply = await asAdmin(opsId)('POST', `/v1/admin/support/threads/${tid}/messages`, { body: 'Premium includes your personalised checklist.', topic: 'presales' });
    expect(reply.status).toBe(201);
    out('support_thread_replied', (await as(u)('GET', '/v1/support/thread')).body);
    out('support_messages', (await as(u)('GET', '/v1/support/messages')).body);
    const denied = await as(u)('POST', '/v1/support/messages', { body: 'Where is my payment?', topic: 'payment' });
    expect(denied.status).toBe(403);
    out('error_support_topic_not_allowed', denied.body);
    const up = await as(u)('POST', '/v1/support/attachments/upload-url', { mime: 'image/png', sizeBytes: 100 });
    expect(up.status).toBe(200);
    out('support_attachment_upload', up.body);
  });

  it('account: consents, devices, export, deletion', async () => {
    const { u } = await onboardedWithCase(false);
    out('consents_unanswered', (await as(u)('GET', '/v1/account/consents')).body);
    out('consents_saved', (await as(u)('PUT', '/v1/account/consents', { analytics: true, crashReports: true, policyVersion: '1.0' })).body);
    out('devices', (await as(u)('GET', '/v1/devices')).body);
    const ex = await as(u)('POST', '/v1/account/data-export');
    expect(ex.status).toBe(202);
    out('data_export_requested', ex.body);
    const stale = await call('DELETE', '/v1/account', { uid: u.uid, deviceId: u.deviceId, body: { confirm: true }, authAge: 3600 });
    expect(stale.status).toBe(401);
    out('error_reauth_required', stale.body);
  });

  it('public: how we verify, eligibility quick check', async () => {
    await q(`TRUNCATE eligibility_check_versions`);
    await q(
      `INSERT INTO eligibility_check_versions (version, questions, summaries, disclaimer, whatsapp_url, is_current, published_at)
       VALUES (1,$1,$2,$3,'https://wa.me/390000000000',true,now())`,
      [
        JSON.stringify([
          { id: 'who', mapsTo: 'relationship_category', text: { en: 'Who is the application for?' }, options: [{ value: 'spouse', label: { en: 'Spouse' } }, { value: 'child', label: { en: 'Child' } }] },
          { id: 'where', mapsTo: 'current_location', text: { en: 'Where are they now?' }, options: [{ value: 'pakistan', label: { en: 'Pakistan' } }, { value: 'italy', label: { en: 'Italy' } }] },
        ]),
        JSON.stringify({ spouse: { en: 'Spouse applications typically involve these documents.' }, child: { en: 'Child applications typically involve these documents.' } }),
        JSON.stringify({ en: 'Orientation only.' }),
      ],
    );
    const qs = await call('GET', '/v1/public/eligibility-check');
    expect(qs.status).toBe(200);
    out('eligibility_questions', qs.body);
    const res = await call('POST', '/v1/public/eligibility-check', { body: { version: 1, answers: { who: 'spouse', where: 'pakistan' } } });
    expect(res.status).toBe(200);
    out('eligibility_result', res.body);
    const bad = await call('POST', '/v1/public/eligibility-check', { body: { version: 99, answers: { who: 'spouse' } } });
    expect(bad.status).toBe(422);
    out('error_eligibility_stale_version', bad.body);
    out('verification_summary', (await call('GET', '/v1/public/verification-summary')).body);
  });
});
