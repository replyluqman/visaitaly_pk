import { sql } from 'drizzle-orm';
import type { RelationshipCategory, RelationshipOption } from '@visaitaly/shared';
import type { Db } from '../../db/client.js';

type RelationshipListRow = {
  code: string;
  label: string;
  category: RelationshipCategory;
  requires_dob: boolean;
};

/** Active relationships in display order, labelled in `locale` with an 'en' fallback. */
export async function listRelationships(db: Db, locale: string): Promise<RelationshipOption[]> {
  const result = await db.execute<RelationshipListRow>(sql`
    SELECT code,
           coalesce(labels->>${locale}, labels->>'en') AS label,
           category,
           requires_dob
      FROM relationships
     WHERE is_active
     ORDER BY sort_order
  `);

  return result.rows.map((r) => ({
    code: r.code,
    label: r.label,
    category: r.category,
    requiresDob: r.requires_dob,
  }));
}
