import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import type { RelationshipCategory, RelationshipOption } from '@visaitaly/shared';
import { requireSession } from '../../middleware/auth.js';
import type { AppEnv } from '../../env.js';

export const referenceRoutes = new Hono<AppEnv>();

referenceRoutes.use('*', requireSession);

type RelationshipListRow = {
  code: string;
  label: string;
  category: RelationshipCategory;
  requires_dob: boolean;
}

/**
 * GET /v1/reference/relationships — Screens §6 picker.
 * CMS-driven so a new relation ships without an app release (PRD §6).
 * Client should cache this; it changes rarely (PRD §4 client-cache-first).
 */
referenceRoutes.get('/relationships', async (c) => {
  const locale = c.req.query('locale');
  const resolved = locale && /^[a-z]{2}$/.test(locale) ? locale : 'en';

  const result = await c.get('db').execute<RelationshipListRow>(sql`
    SELECT code,
           coalesce(labels->>${resolved}, labels->>'en') AS label,
           category,
           requires_dob
      FROM relationships
     WHERE is_active
     ORDER BY sort_order
  `);

  const relationships: RelationshipOption[] = result.rows.map((r) => ({
    code: r.code,
    label: r.label,
    category: r.category,
    requiresDob: r.requires_dob,
  }));

  return c.json({ relationships });
});
