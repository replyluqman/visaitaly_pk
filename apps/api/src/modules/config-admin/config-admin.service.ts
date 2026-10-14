import { sql } from 'drizzle-orm';
import {
  CONFIG_KEYS, CONFIG_SCHEMAS,
  type AdminOverview, type ConfigEntry, type ConfigKey,
} from '@visaitaly/shared';
import type { Db } from '../../db/client.js';
import type { AdminContext } from '../../env.js';
import { AppError } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { readConfig, VERIFICATION_CONFIG_FALLBACK } from '../../lib/app-config.js';
import { findForbiddenPhrase } from '../support-admin/support-admin.service.js';
import { supportSummary } from '../support-admin/support-admin.service.js';
import { AdminScope } from '@visaitaly/shared';

const iso = (v: string | null) => (v ? new Date(v).toISOString() : null);

// ---------------------------------------------------------------------------
// Pricing / CMS config (Screen 43, scope pricing_config)
// ---------------------------------------------------------------------------

type ConfigRow = { key: string; value: Record<string, unknown>; description: string | null; updated_by: string | null; updated_at: string };

/** Every editable key, with its row if one exists (a fresh database runs on the built-in fallbacks). */
export async function listConfig(db: Db): Promise<ConfigEntry[]> {
  const r = await db.execute<ConfigRow>(sql`SELECT key, value, description, updated_by, updated_at FROM app_config ORDER BY key`);
  const rows = new Map(r.rows.map((x) => [x.key, x]));
  return CONFIG_KEYS.map((key) => {
    const row = rows.get(key);
    return {
      key, value: row?.value ?? {}, isDefault: !row,
      description: row?.description ?? null, updatedBy: row?.updated_by ?? null, updatedAt: iso(row?.updated_at ?? null),
    };
  });
}

/** Copy inside config is held to the same verdict-language rule as every other user-facing text (PRD §10, §18). */
function screenCopy(key: ConfigKey, value: Record<string, unknown>): void {
  if (key !== 'sla') return;
  const text = value.working_hours_text as Record<string, string> | undefined;
  for (const [lang, t] of Object.entries(text ?? {})) {
    const bad = findForbiddenPhrase(t);
    if (bad) throw AppError.validation({ value: [`working_hours_text.${lang} contains "${bad}", which gives a verdict. Rephrase.`] });
  }
}

/**
 * Replace one config value. The new value must satisfy the key's strict schema in full; the before/after
 * values are audited in the same transaction. Takes effect on the next request — no app release.
 */
export async function putConfig(
  db: Db, actor: AdminContext, key: ConfigKey, raw: unknown, requestId?: string,
): Promise<ConfigEntry> {
  const parsed = CONFIG_SCHEMAS[key].safeParse(raw);
  if (!parsed.success) {
    const details: Record<string, string[]> = {};
    for (const i of parsed.error.issues) (details[`value.${i.path.join('.')}`.replace(/\.$/, '')] ??= []).push(i.message);
    throw AppError.validation(details);
  }
  const value = parsed.data as Record<string, unknown>;
  screenCopy(key, value);

  await db.transaction(async (tx) => {
    const before = await tx.execute<{ value: unknown }>(sql`SELECT value FROM app_config WHERE key = ${key} FOR UPDATE`);
    await tx.execute(sql`
      INSERT INTO app_config (key, value, updated_by, updated_at)
      VALUES (${key}, ${JSON.stringify(value)}::jsonb, ${actor.id}::uuid, now())
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at
    `);
    await audit(tx, {
      actorType: 'admin', actorId: actor.id, action: 'config.update', targetType: 'app_config', targetId: key,
      metadata: { before: before.rows[0]?.value ?? null, after: value }, requestId,
    });
  });
  return (await listConfig(db)).find((e) => e.key === key)!;
}

// ---------------------------------------------------------------------------
// Admin home / overview (Screen 31)
// ---------------------------------------------------------------------------

/**
 * Queue counts with SLA breaches, filtered to what this admin may see: a section appears for super, for its own
 * scope, or for read_only. Sections for modules not built yet (payments, refunds, payouts, renewals) are absent,
 * not zero — a zero would read as "all clear". Each section is one indexed aggregate.
 */
export async function adminOverview(db: Db, actor: AdminContext): Promise<AdminOverview> {
  const sees = (scope: AdminScope) => actor.isSuper || actor.scopes.has(scope) || actor.scopes.has(AdminScope.READ_ONLY);
  const out: AdminOverview = {};
  const jobs: Promise<void>[] = [];

  if (sees(AdminScope.SUPPORT_MANAGE)) jobs.push(supportSummary(db).then((s) => { out.support = s; }));

  if (sees(AdminScope.VERIFICATION_MANAGE)) {
    jobs.push((async () => {
      const cfg = await readConfig(db, 'verification', VERIFICATION_CONFIG_FALLBACK);
      const r = await db.execute<{ flags: number; unreachable: number; drafts: number; verified: number }>(sql`
        SELECT (SELECT count(*)::int FROM source_flags WHERE status = 'open') AS flags,
               (SELECT count(*)::int FROM sources WHERE is_active AND consecutive_failures >= ${cfg.failure_alert_after}) AS unreachable,
               (SELECT count(*)::int FROM requirements WHERE verification_status = 'created') AS drafts,
               (SELECT count(*)::int FROM requirements WHERE verification_status = 'verified') AS verified
      `);
      const x = r.rows[0]!;
      out.verification = { openHashFlags: x.flags, unreachableSources: x.unreachable, drafts: x.drafts, awaitingPublish: x.verified };
    })());
  }

  if (sees(AdminScope.LEGAL_MANAGE)) {
    jobs.push(db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM legal_versions WHERE published_at IS NULL`)
      .then((r) => { out.legal = { draftVersions: r.rows[0]!.n }; }));
  }

  // Privacy requests have no scope of their own (the Cron processes them): operational visibility for super / read_only.
  if (actor.isSuper || actor.scopes.has(AdminScope.READ_ONLY)) {
    jobs.push(db.execute<{ n: number; oldest: string | null }>(sql`
      SELECT count(*)::int AS n, min(requested_at)::text AS oldest FROM data_requests WHERE status IN ('received','processing')
    `).then((r) => { out.privacy = { openRequests: r.rows[0]!.n, oldestOpenAt: iso(r.rows[0]!.oldest) }; }));
  }

  await Promise.all(jobs);
  return out;
}
