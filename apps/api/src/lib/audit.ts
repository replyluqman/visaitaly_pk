import { sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';

export interface AuditEvent {
  actorType: 'admin' | 'user' | 'system';
  actorId: string | null;
  /** Dotted verb, e.g. `admin.create`, `requirement.publish`, `case.lookup`. */
  action: string;
  targetType?: string;
  targetId?: string;
  /** Ids and changed field NAMES only — never PII values (docs/SECURITY.md). */
  metadata?: Record<string, unknown>;
  requestId?: string;
}

/**
 * Append one row to the audit log. Call it with the SAME transaction handle as the action it
 * records, so the action and its evidence commit or roll back together (PRD §16, §18).
 */
export async function audit(db: Db, e: AuditEvent): Promise<void> {
  await db.execute(sql`
    INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, metadata, request_id)
    VALUES (${e.actorType}, ${e.actorId}::uuid, ${e.action}, ${e.targetType ?? null},
            ${e.targetId ?? null}, ${JSON.stringify(e.metadata ?? {})}::jsonb, ${e.requestId ?? null})
  `);
}
