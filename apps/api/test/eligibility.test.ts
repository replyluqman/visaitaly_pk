import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { call, rawFetch } from './helpers/app.js';
import { closePool, q, resetDb, seedCatalogue } from './helpers/db.js';

const rules = JSON.parse(readFileSync(new URL('../copy-rules.json', import.meta.url), 'utf8')) as {
  forbiddenPhrases: string[];
  placeholderMarker: string;
};

beforeEach(async () => {
  await resetDb();
  await q(`TRUNCATE eligibility_check_versions`);
  await seedCatalogue();
});
afterAll(closePool);

const QUESTIONS = [
  {
    id: 'who', mapsTo: 'relationship_category', text: { en: 'Who is the application for?' },
    options: [
      { value: 'spouse', label: { en: 'Spouse' } },
      { value: 'child', label: { en: 'Child' } },
      { value: 'parent', label: { en: 'Parent' } },
    ],
  },
  {
    id: 'where', mapsTo: 'current_location', text: { en: 'Where are they now?' },
    options: [
      { value: 'pakistan', label: { en: 'Pakistan' } },
      { value: 'italy', label: { en: 'Italy' } },
    ],
  },
];

async function publish(opts: { version?: number; whatsapp?: string | null } = {}) {
  await q(`UPDATE eligibility_check_versions SET is_current = false`);
  await q(
    `INSERT INTO eligibility_check_versions (version, questions, summaries, disclaimer, whatsapp_url, is_current, published_at)
     VALUES ($1,$2,$3,$4,$5,true,now())`,
    [
      opts.version ?? 1,
      JSON.stringify(QUESTIONS),
      JSON.stringify({
        spouse: { en: 'Spouse applications typically involve these documents.' },
        child: { en: 'Child applications typically involve these documents.' },
        parent: { en: 'Parent applications typically involve these documents.' },
      }),
      JSON.stringify({ en: 'Orientation only.' }),
      opts.whatsapp ?? null,
    ],
  );
}

describe('GET /v1/public/eligibility-check', () => {
  it('404 until a version is published', async () => {
    const r = await call('GET', '/v1/public/eligibility-check');
    expect(r.status).toBe(404);
  });

  it('needs no auth; returns questions without server-side mapping hints; cacheable', async () => {
    await publish();
    const res = await rawFetch('/v1/public/eligibility-check');
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=3600');
    const body = (await res.json()) as any;
    expect(body).toMatchObject({ version: 1, disclaimer: 'Orientation only.' });
    expect(body.questions).toHaveLength(2);
    expect(body.questions[0]).toEqual({
      id: 'who', text: 'Who is the application for?',
      options: [{ value: 'spouse', label: 'Spouse' }, { value: 'child', label: 'Child' }, { value: 'parent', label: 'Parent' }],
    });
    expect(JSON.stringify(body)).not.toContain('mapsTo');
  });

  it('falls back to en for an unknown locale', async () => {
    await publish();
    const r = await call('GET', '/v1/public/eligibility-check?locale=ur');
    expect(r.body.questions[0].text).toBe('Who is the application for?');
  });
});

describe('POST /v1/public/eligibility-check', () => {
  const post = (body: unknown) => call('POST', '/v1/public/eligibility-check', { body });

  it('returns orientation: CMS summary, ≤3 typical items from the same applicability rules, lockedCount', async () => {
    await publish({ whatsapp: 'https://wa.me/920000000000' });
    const r = await post({ version: 1, answers: { who: 'spouse', where: 'pakistan' } });
    expect(r.status).toBe(200);
    expect(r.body.summary).toBe('Spouse applications typically involve these documents.');
    expect(r.body.typicalItems.map((i: any) => i.title)).toEqual(['passport', 'nikah', 'adult_only']);
    expect(r.body.typicalItems[0]).toEqual({ title: 'passport', why: 'why' });
    // spouse+pakistan: passport, nikah, adult_only, minor_only (DOB not asked), after_nulla (status not asked), appointment_slot, visa_form
    expect(r.body.lockedCount).toBe(4);
    expect(r.body.disclaimer).toBe('Orientation only.');
    expect(r.body.whatsappUrl).toBe('https://wa.me/920000000000');
  });

  it('the category changes the items; location narrows them; not cached', async () => {
    await publish();
    const child = await post({ version: 1, answers: { who: 'child', where: 'pakistan' } });
    expect(child.body.typicalItems.map((i: any) => i.title)).toEqual(['passport', 'birth_cert', 'adult_only']); // age/Nulla Osta not asked → never excluded
    const italy = await post({ version: 1, answers: { who: 'spouse', where: 'italy' } });
    expect(italy.body.typicalItems.map((i: any) => i.title)).toContain('passport');
    const res = await rawFetch('/v1/public/eligibility-check', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: 1, answers: { who: 'spouse', where: 'pakistan' } }),
    });
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('persists nothing', async () => {
    await publish();
    const before = await q(`SELECT (SELECT count(*) FROM users) u, (SELECT count(*) FROM devices) d,
      (SELECT count(*) FROM applicants) a, (SELECT count(*) FROM applicant_requirements) ar`);
    await post({ version: 1, answers: { who: 'spouse', where: 'pakistan' } });
    const after = await q(`SELECT (SELECT count(*) FROM users) u, (SELECT count(*) FROM devices) d,
      (SELECT count(*) FROM applicants) a, (SELECT count(*) FROM applicant_requirements) ar`);
    expect(after).toEqual(before);
  });

  it('422: stale version, unknown question, missing answer, invalid option, bad shape', async () => {
    await publish({ version: 2 });
    const stale = await post({ version: 1, answers: { who: 'spouse', where: 'pakistan' } });
    expect(stale.status).toBe(422);
    expect(stale.body.error.details.version).toBeDefined();
    const unknown = await post({ version: 2, answers: { who: 'spouse', where: 'pakistan', extra: 'x' } });
    expect(unknown.body.error.details.extra).toBeDefined();
    const missing = await post({ version: 2, answers: { who: 'spouse' } });
    expect(missing.body.error.details.where).toBeDefined();
    const bad = await post({ version: 2, answers: { who: 'cousin', where: 'pakistan' } });
    expect(bad.body.error.details.who).toBeDefined();
    for (const body of [{}, { version: 2 }, { version: 2, answers: {} }, { version: 'x', answers: {} },
      { version: 2, answers: { who: 'x'.repeat(65) } },
      { version: 2, answers: Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`q${i}`, 'a'])) }]) {
      expect((await post(body)).status).toBe(422);
    }
    expect((await call('POST', '/v1/public/eligibility-check', { rawBody: '{nope' })).status).toBe(422);
  });

  it('404 when nothing is published', async () => {
    expect((await post({ version: 1, answers: { who: 'spouse' } })).status).toBe(404);
  });

  it('a misconfigured version (no category question) is an opaque 500, never wrong advice', async () => {
    await q(
      `INSERT INTO eligibility_check_versions (version, questions, summaries, disclaimer, is_current, published_at)
       VALUES (1, '[{"id":"x","text":{"en":"?"},"options":[{"value":"a","label":{"en":"A"}}]}]', '{}', '{"en":"d"}', true, now())`);
    const r = await post({ version: 1, answers: { x: 'a' } });
    expect(r.status).toBe(500);
    expect(r.body.error.code).toBe('INTERNAL');
  });
});

describe('copy rules (PRD §18 Risk 1)', () => {
  it('the rules file is non-empty and lower-case (preflight matches case-insensitively)', () => {
    expect(rules.forbiddenPhrases.length).toBeGreaterThan(0);
    for (const p of rules.forbiddenPhrases) expect(p).toBe(p.toLowerCase());
  });

  it('the dev seed carries the placeholder marker on every string, so preflight blocks it', () => {
    const sql = readFileSync(new URL('../seed/seed_dev_eligibility.sql', import.meta.url), 'utf8');
    expect(sql).toContain(rules.placeholderMarker);
    for (const p of rules.forbiddenPhrases) expect(sql.toLowerCase()).not.toContain(p);
  });
});

describe('schema guards', () => {
  it('only one current version; current must be published; ≤ 6 questions; wa.me only', async () => {
    await publish();
    await expect(q(`INSERT INTO eligibility_check_versions (version, questions, summaries, disclaimer, is_current, published_at)
      VALUES (9,'[{"id":"a"}]','{}','{}',true,now())`)).rejects.toThrow();
    await expect(q(`INSERT INTO eligibility_check_versions (version, questions, summaries, disclaimer, is_current)
      VALUES (9,'[{"id":"a"}]','{}','{}',true)`)).rejects.toThrow();
    await expect(q(`INSERT INTO eligibility_check_versions (version, questions, summaries, disclaimer)
      VALUES (9,'[1,2,3,4,5,6,7]','{}','{}')`)).rejects.toThrow();
    await expect(q(`INSERT INTO eligibility_check_versions (version, questions, summaries, disclaimer, whatsapp_url)
      VALUES (9,'[{"id":"a"}]','{}','{}','http://evil.example')`)).rejects.toThrow();
  });
});
