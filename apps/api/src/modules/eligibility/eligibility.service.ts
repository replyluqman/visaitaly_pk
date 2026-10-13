import { sql } from 'drizzle-orm';
import type {
  EligibilityAnswersInput,
  EligibilityQuestion,
  EligibilityQuestionSet,
  EligibilityResult,
} from '@visaitaly/shared';
import type { Db } from '../../db/client.js';
import { AppError } from '../../lib/errors.js';
import { CHECKLIST_CONFIG_FALLBACK, readConfig } from '../../lib/app-config.js';
import { requirementApplies } from '../checklist/applicability.js';

type Localized = Record<string, string>;
type StoredQuestion = {
  id: string;
  text: Localized;
  mapsTo?: 'relationship_category' | 'current_location' | 'nulla_osta_status';
  options: Array<{ value: string; label: Localized }>;
};
type VersionRow = {
  version: number;
  questions: StoredQuestion[];
  summaries: Record<string, Localized>;
  disclaimer: Localized;
  whatsapp_url: string | null;
};

const pick = (l: Localized | undefined, locale: string): string => l?.[locale] ?? l?.en ?? '';

async function loadCurrent(db: Db): Promise<VersionRow> {
  const r = await db.execute<VersionRow>(sql`
    SELECT version, questions, summaries, disclaimer, whatsapp_url
      FROM eligibility_check_versions WHERE is_current
  `);
  const row = r.rows[0];
  if (!row) throw AppError.notFound('The Quick Check is not available yet.');
  return row;
}

/** GET /v1/public/eligibility-check — pre-auth (Screen 2). Mapping hints stay server-side. */
export async function getQuestionSet(db: Db, locale: string): Promise<EligibilityQuestionSet> {
  const v = await loadCurrent(db);
  return {
    version: v.version,
    disclaimer: pick(v.disclaimer, locale),
    questions: v.questions.map(
      (q): EligibilityQuestion => ({
        id: q.id,
        text: pick(q.text, locale),
        options: q.options.map((o) => ({ value: o.value, label: pick(o.label, locale) })),
      }),
    ),
  };
}

/**
 * POST /v1/public/eligibility-check — stateless orientation (PRD §11, §18 Risk 1).
 *
 * Nothing is persisted: no answers, no IP, no identifier. The result is derived from the
 * same applicability definition case generation uses, so the "typical items" shown here
 * are exactly what the user's real case would contain. Wording comes entirely from the
 * CMS-owned version row; this code adds no sentence of its own.
 */
export async function evaluate(
  db: Db,
  input: EligibilityAnswersInput,
  locale: string,
): Promise<EligibilityResult> {
  const v = await loadCurrent(db);
  if (input.version !== v.version) {
    throw AppError.validation({
      version: ['The questions have changed. Please reload and answer again.'],
    });
  }

  const details: Record<string, string[]> = {};
  const known = new Set(v.questions.map((q) => q.id));
  for (const key of Object.keys(input.answers)) {
    if (!known.has(key)) details[key] = ['Unknown question.'];
  }
  const profile: Partial<Record<NonNullable<StoredQuestion['mapsTo']>, string>> = {};
  for (const q of v.questions) {
    const given = input.answers[q.id];
    if (given === undefined) {
      details[q.id] = ['An answer is required.'];
    } else if (!q.options.some((o) => o.value === given)) {
      details[q.id] = ['Not a valid option.'];
    } else if (q.mapsTo) {
      profile[q.mapsTo] = given;
    }
  }
  if (Object.keys(details).length > 0) throw AppError.validation(details);

  const category = profile.relationship_category;
  const summary = category ? pick(v.summaries[category], locale) : '';
  if (!category || !summary) {
    // A published version without a category question or summary is a content-setup bug, not user error.
    throw new Error(`eligibility version ${v.version} is misconfigured (category/summary)`);
  }

  const cap = (await readConfig(db, 'checklist', CHECKLIST_CONFIG_FALLBACK)).free_preview_items;
  const items = await db.execute<{ title: string; purpose: string | null; total: number }>(sql`
    SELECT coalesce(r.title->>${locale}, r.title->>'en')     AS title,
           coalesce(r.purpose->>${locale}, r.purpose->>'en') AS purpose,
           count(*) OVER ()::int                              AS total
      FROM requirements r
     WHERE r.verification_status = 'published'
       AND ${requirementApplies({
         category: sql`${category}::text`,
         location: sql`${profile.current_location ?? null}::text`,
         nullaOstaStatus: sql`${profile.nulla_osta_status ?? null}::text`,
         dateOfBirth: sql`NULL::date`,
       })}
     ORDER BY r.stage_order, r.sort_order, r.id
     LIMIT ${cap}
  `);

  // total is the window count over ALL matches (before LIMIT).
  const total = items.rows[0]?.total ?? 0;
  return {
    summary,
    typicalItems: items.rows.map((r) => ({ title: r.title, why: r.purpose })),
    lockedCount: Math.max(0, total - items.rows.length),
    disclaimer: pick(v.disclaimer, locale),
    whatsappUrl: v.whatsapp_url,
  };
}
