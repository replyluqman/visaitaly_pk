import { sql } from 'drizzle-orm';
import {
  AccessLevel,
  STAGE_SEQUENCE,
  TodayKind,
  type JourneyStage,
  type TodayAction,
  type TodayResponse,
} from '@visaitaly/shared';
import type { Db } from '../../db/client.js';
import { AppError } from '../../lib/errors.js';
import { TODAY_CONFIG_FALLBACK, readConfig } from '../../lib/app-config.js';
import { resolveAccess } from '../applicants/access.js';

// ---------------------------------------------------------------------------
// Cron: materialise next_actions (PRD §15 — never computed on the request path)
// ---------------------------------------------------------------------------

/**
 * Refreshes the `batch_size` stalest applicants (never-computed first) in ONE set-based
 * statement, so the Worker issues a single query regardless of batch size.
 *
 * Candidate actions, best rank wins when an item qualifies twice:
 *   1 expiring  — an active document's expiry, or a received Nulla Osta's expiry, inside
 *                 `expiry_window_days` (already-expired counts); soonest first
 *   2 blocking  — applicable item that blocks submission and is not ready
 *   3 todo      — applicable, not-ready item in the applicant's current stage
 *                 (issue found, then in progress, then not started)
 * "Waiting on us" arrives with orders (Modules 6/7).
 *
 * Titles are stored as the requirement's locale map; the sentence is the client's job —
 * the server holds no hard-coded English (invariant 1).
 */
export async function refreshNextActions(db: Db): Promise<{ refreshed: number }> {
  const cfg = await readConfig(db, 'today', TODAY_CONFIG_FALLBACK);
  const result = await db.execute(sql`
    WITH batch AS (
      SELECT a.id, a.user_id, a.current_stage, a.nulla_osta_status, a.nulla_osta_expiry_date
        FROM applicants a
        LEFT JOIN next_actions n ON n.applicant_id = a.id
       WHERE a.status = 'active' AND a.case_generated_at IS NOT NULL
       ORDER BY n.computed_at NULLS FIRST, a.id
       LIMIT ${cfg.batch_size}
    ),
    cand AS (
      -- 1a. documents about to expire
      SELECT b.id AS applicant_id, 1 AS kind_rank, 'expiring' AS kind, 'document_expires' AS reason,
             r.title AS title, ar.id AS item_id, d.expiry_date AS due_date, 0 AS sub_rank,
             coalesce(r.stage_order, 0) AS stage_order, coalesce(r.sort_order, 0) AS sort_order
        FROM batch b
        CROSS JOIN LATERAL (
          SELECT d.applicant_requirement_id, d.expiry_date FROM documents d
           WHERE d.applicant_id = b.id AND d.status = 'active' AND d.expiry_date IS NOT NULL
             AND d.expiry_date <= CURRENT_DATE + ${cfg.expiry_window_days}::int
          OFFSET 0
        ) d
        LEFT JOIN applicant_requirements ar ON ar.id = d.applicant_requirement_id
        LEFT JOIN requirements r ON r.id = ar.requirement_id
      UNION ALL
      -- 1b. Nulla Osta about to expire
      SELECT b.id, 1, 'expiring', 'nulla_osta_expires', NULL::jsonb, NULL::uuid,
             b.nulla_osta_expiry_date, 0, 0, 0
        FROM batch b
       WHERE b.nulla_osta_status = 'received' AND b.nulla_osta_expiry_date IS NOT NULL
         AND b.nulla_osta_expiry_date <= CURRENT_DATE + ${cfg.expiry_window_days}::int
      UNION ALL
      -- 2. blocking submission
      SELECT b.id, 2, 'blocking', 'blocks_submission', r.title, ar.id, NULL::date, 0,
             r.stage_order, r.sort_order
        FROM batch b
        CROSS JOIN LATERAL (
          SELECT ar.id, ar.requirement_id, ar.status FROM applicant_requirements ar
           WHERE ar.applicant_id = b.id AND ar.is_applicable AND ar.status <> 'ready'
          OFFSET 0 -- planner fence: one index probe per batch applicant, never a scan of the table
        ) ar
        JOIN requirements r ON r.id = ar.requirement_id AND r.blocks_submission
      UNION ALL
      -- 3. to do in the current stage
      SELECT b.id, 3, 'todo',
             CASE ar.status WHEN 'issue_found' THEN 'issue_found' WHEN 'in_progress' THEN 'in_progress'
                            ELSE 'not_started' END,
             r.title, ar.id, NULL::date,
             CASE ar.status WHEN 'issue_found' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END,
             r.stage_order, r.sort_order
        FROM batch b
        CROSS JOIN LATERAL (
          SELECT ar.id, ar.requirement_id, ar.status FROM applicant_requirements ar
           WHERE ar.applicant_id = b.id AND ar.is_applicable AND ar.status <> 'ready'
          OFFSET 0
        ) ar
        JOIN requirements r ON r.id = ar.requirement_id AND r.stage = b.current_stage
    ),
    best AS (
      -- An item that qualifies twice appears once, at its best rank.
      SELECT DISTINCT ON (applicant_id, coalesce(item_id::text, kind || reason)) *
        FROM cand
       ORDER BY applicant_id, coalesce(item_id::text, kind || reason), kind_rank, sub_rank
    ),
    ranked AS (
      SELECT *, row_number() OVER (
               PARTITION BY applicant_id
               ORDER BY kind_rank, due_date NULLS LAST, sub_rank, stage_order, sort_order, item_id) AS rn
        FROM best
    ),
    agg AS (
      SELECT applicant_id,
             jsonb_agg(jsonb_build_object(
               'kind', kind, 'reason', reason, 'title', title, 'itemId', item_id,
               'dueDate', to_char(due_date, 'YYYY-MM-DD'), 'rank', kind_rank) ORDER BY rn) AS actions
        FROM ranked WHERE rn <= ${cfg.max_actions}
       GROUP BY applicant_id
    )
    INSERT INTO next_actions (applicant_id, user_id, actions, computed_at)
    SELECT b.id, b.user_id, coalesce(agg.actions, '[]'::jsonb), now()
      FROM batch b LEFT JOIN agg ON agg.applicant_id = b.id
    ON CONFLICT (applicant_id) DO UPDATE
       SET actions = EXCLUDED.actions, user_id = EXCLUDED.user_id, computed_at = EXCLUDED.computed_at
  `);
  return { refreshed: result.rowCount ?? 0 };
}

// ---------------------------------------------------------------------------
// GET /v1/today — a read of the materialised rows, nothing more
// ---------------------------------------------------------------------------

type StoredAction = {
  kind: TodayAction['kind'];
  reason: TodayAction['reason'];
  title: Record<string, string> | null;
  itemId: string | null;
  dueDate: string | null;
  rank: number;
};

type TodayRow = {
  id: string;
  current_stage: JourneyStage | null;
  premium_status: 'none' | 'active' | 'expired_pending_confirmation' | 'expired';
  access_until: string | null;
  grace_until: string | null;
  actions: StoredAction[] | null;
  computed_at: string | null;
};

export async function getToday(db: Db, userId: string, locale: string): Promise<TodayResponse> {
  const cfg = await readConfig(db, 'today', TODAY_CONFIG_FALLBACK);
  const result = await db.execute<TodayRow>(sql`
    SELECT a.id, a.current_stage, a.premium_status, a.access_until, a.grace_until,
           n.actions, n.computed_at
      FROM applicants a
      LEFT JOIN next_actions n ON n.applicant_id = a.id AND n.user_id = a.user_id
     WHERE a.user_id = ${userId} AND a.status = 'active'
     ORDER BY a.created_at
  `);

  // Premium feature (PRD §8): free and expired applicants contribute nothing.
  const eligible = result.rows.filter((r) => {
    const level = resolveAccess(r).level;
    return level === AccessLevel.PREMIUM || level === AccessLevel.GRACE_READ_ONLY;
  });
  if (eligible.length === 0) throw AppError.premiumRequired('Today is part of Premium.');

  const flat: Array<TodayAction & { rank: number; order: number }> = [];
  let order = 0;
  for (const row of eligible) {
    for (const a of row.actions ?? []) {
      flat.push({
        kind: a.kind,
        reason: a.reason,
        title: a.title ? (a.title[locale] ?? a.title.en ?? null) : null,
        applicantId: row.id,
        itemId: a.itemId,
        dueDate: a.dueDate,
        deepLink: a.itemId ? `/checklist/${a.itemId}` : `/applicants/${row.id}`,
        rank: a.rank,
        order: order++,
      });
    }
  }
  flat.sort(
    (x, y) =>
      x.rank - y.rank ||
      (x.dueDate ?? '9999-12-31').localeCompare(y.dueDate ?? '9999-12-31') ||
      x.order - y.order,
  );
  const actions: TodayAction[] = flat
    .slice(0, cfg.max_actions)
    .map(({ rank: _r, order: _o, ...a }) => a);

  const computed = eligible.map((r) => r.computed_at);
  const computedAt = computed.some((c) => c === null)
    ? null
    : new Date(Math.min(...computed.map((c) => new Date(c as string).getTime()))).toISOString();

  let allClear: TodayResponse['allClear'] = null;
  if (actions.length === 0) {
    const stages = eligible
      .map((r) => (r.current_stage ? STAGE_SEQUENCE.indexOf(r.current_stage) : -1))
      .filter((i) => i >= 0);
    const furthestBehind = stages.length ? Math.min(...stages) : -1;
    allClear = { nextStage: STAGE_SEQUENCE[furthestBehind + 1] ?? null };
  }
  return { actions, allClear, computedAt };
}
