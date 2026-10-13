import { sql } from 'drizzle-orm';
import type {
  AdminList,
  AdminProfile,
  AdminScope,
  AuditList,
  AuditQuery,
  CreateAdminInput,
  PatchAdminInput,
} from '@visaitaly/shared';
import type { Db } from '../../db/client.js';
import type { AdminContext } from '../../env.js';
import { AppError } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { decodeTsCursor, encodeTsCursor } from '../../lib/cursor.js';

type AdminRowRaw = {
  id: string;
  firebase_uid: string | null;
  email: string;
  display_name: string | null;
  is_super: boolean;
  status: 'active' | 'disabled';
  last_login_at: string | null;
  created_at: string;
  created_at_raw: string;
  scopes: AdminScope[];
};

const toProfile = (r: AdminRowRaw): AdminProfile => ({
  id: r.id,
  email: r.email,
  displayName: r.display_name,
  isSuper: r.is_super,
  status: r.status,
  scopes: [...r.scopes].sort(),
  linked: r.firebase_uid !== null,
  lastLoginAt: r.last_login_at ? new Date(r.last_login_at).toISOString() : null,
  createdAt: new Date(r.created_at).toISOString(),
});

const SELECT_ADMIN = sql`
  SELECT a.id, a.firebase_uid, a.email, a.display_name, a.is_super, a.status, a.last_login_at, a.created_at, a.created_at::text AS created_at_raw,
         coalesce(array_agg(p.scope) FILTER (WHERE p.scope IS NOT NULL), '{}') AS scopes
    FROM admins a
    LEFT JOIN admin_permissions p ON p.admin_id = a.id
`;

export async function getAdminProfile(db: Db, id: string): Promise<AdminProfile> {
  const r = await db.execute<AdminRowRaw>(sql`${SELECT_ADMIN} WHERE a.id = ${id}::uuid GROUP BY a.id`);
  const row = r.rows[0];
  if (!row) throw AppError.notFound('Admin not found.');
  return toProfile(row);
}

// ---------------------------------------------------------------------------
// super-admin: manage admins (Screen 32)
// ---------------------------------------------------------------------------

export async function listAdmins(db: Db, cursor: string | undefined, limit: number): Promise<AdminList> {
  const after = cursor ? decodeTsCursor(cursor) : null;
  const r = await db.execute<AdminRowRaw>(sql`
    ${SELECT_ADMIN}
    ${after ? sql`WHERE (a.created_at, a.id) > (${after[0]}::timestamptz, ${after[1]}::uuid)` : sql``}
    GROUP BY a.id
    ORDER BY a.created_at, a.id
    LIMIT ${limit + 1}
  `);
  const page = r.rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page.map(toProfile),
    nextCursor: r.rows.length > limit && last ? encodeTsCursor(last.created_at_raw, last.id) : null,
  };
}

async function setScopes(tx: Db, adminId: string, scopes: AdminScope[], grantedBy: string): Promise<void> {
  await tx.execute(sql`DELETE FROM admin_permissions WHERE admin_id = ${adminId}::uuid`);
  for (const scope of new Set(scopes)) {
    await tx.execute(sql`
      INSERT INTO admin_permissions (admin_id, scope, granted_by)
      VALUES (${adminId}::uuid, ${scope}, ${grantedBy}::uuid)
    `);
  }
}

export async function createAdmin(
  db: Db,
  actor: AdminContext,
  input: CreateAdminInput,
  requestId: string,
): Promise<AdminProfile> {
  const id = await db.transaction(async (tx) => {
    const dup = await tx.execute(sql`SELECT 1 FROM admins WHERE email = ${input.email}`);
    if (dup.rows.length > 0) throw AppError.conflict('An admin with that email already exists.');
    const created = await tx.execute<{ id: string }>(sql`
      INSERT INTO admins (email, display_name, is_super, created_by)
      VALUES (${input.email}, ${input.displayName ?? null}, ${input.isSuper}, ${actor.id}::uuid)
      RETURNING id
    `);
    const adminId = created.rows[0]!.id;
    await setScopes(tx, adminId, input.scopes, actor.id);
    await audit(tx, {
      actorType: 'admin', actorId: actor.id, action: 'admin.create', targetType: 'admin', targetId: adminId,
      metadata: { isSuper: input.isSuper, scopes: [...new Set(input.scopes)].sort() }, requestId,
    });
    return adminId;
  });
  return getAdminProfile(db, id);
}

export async function patchAdmin(
  db: Db,
  actor: AdminContext,
  id: string,
  input: PatchAdminInput,
  requestId: string,
): Promise<AdminProfile> {
  await db.transaction(async (tx) => {
    const cur = await tx.execute<{ is_super: boolean; status: 'active' | 'disabled' }>(sql`
      SELECT is_super, status FROM admins WHERE id = ${id}::uuid FOR UPDATE
    `);
    const row = cur.rows[0];
    if (!row) throw AppError.notFound('Admin not found.');

    const nextSuper = input.isSuper ?? row.is_super;
    const nextStatus = input.status ?? row.status;

    // Lock-out guards: nobody disables or demotes themselves, and the last active super stays.
    if (actor.id === id && (nextStatus !== 'active' || !nextSuper)) {
      throw AppError.conflict('You cannot disable or demote yourself.');
    }
    if (row.is_super && row.status === 'active' && (!nextSuper || nextStatus !== 'active')) {
      const others = await tx.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM admins
         WHERE is_super AND status = 'active' AND id <> ${id}::uuid
      `);
      if ((others.rows[0]?.n ?? 0) === 0) throw AppError.conflict('There must be at least one active super admin.');
    }

    const sets = [];
    if (input.displayName !== undefined) sets.push(sql`display_name = ${input.displayName}`);
    if (input.status !== undefined) sets.push(sql`status = ${input.status}`);
    if (input.isSuper !== undefined) sets.push(sql`is_super = ${input.isSuper}`);
    if (sets.length > 0) {
      await tx.execute(sql`UPDATE admins SET ${sql.join(sets, sql`, `)} WHERE id = ${id}::uuid`);
    }

    let added: string[] = [];
    let removed: string[] = [];
    if (input.scopes !== undefined) {
      const before = await tx.execute<{ scope: string }>(sql`
        SELECT scope FROM admin_permissions WHERE admin_id = ${id}::uuid
      `);
      const prev = new Set(before.rows.map((r) => r.scope));
      const next = new Set<string>(input.scopes);
      added = [...next].filter((s) => !prev.has(s)).sort();
      removed = [...prev].filter((s) => !next.has(s)).sort();
      await setScopes(tx, id, input.scopes, actor.id);
    }

    await audit(tx, {
      actorType: 'admin', actorId: actor.id, action: 'admin.update', targetType: 'admin', targetId: id,
      metadata: { fields: Object.keys(input).sort(), scopesAdded: added, scopesRemoved: removed }, requestId,
    });
  });
  return getAdminProfile(db, id);
}

// ---------------------------------------------------------------------------
// audit viewer (Screen 45) — any admin may read
// ---------------------------------------------------------------------------

type AuditRowRaw = {
  id: string;
  actor_type: 'admin' | 'user' | 'system';
  actor_id: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  metadata: Record<string, unknown>;
  request_id: string | null;
  created_at: string;
  created_at_raw: string;
};

export async function listAudit(db: Db, q: AuditQuery): Promise<AuditList> {
  const where = [];
  if (q.actorId) where.push(sql`actor_id = ${q.actorId}::uuid`);
  if (q.action) where.push(sql`action = ${q.action}`);
  if (q.targetType) where.push(sql`target_type = ${q.targetType}`);
  if (q.targetId) where.push(sql`target_id = ${q.targetId}`);
  if (q.cursor) {
    const [at, id] = decodeTsCursor(q.cursor);
    where.push(sql`(created_at, id) < (${at}::timestamptz, ${id}::uuid)`);
  }
  const r = await db.execute<AuditRowRaw>(sql`
    SELECT id, actor_type, actor_id, action, target_type, target_id, metadata, request_id, created_at,
           created_at::text AS created_at_raw
      FROM audit_log
     ${where.length ? sql`WHERE ${sql.join(where, sql` AND `)}` : sql``}
     ORDER BY created_at DESC, id DESC
     LIMIT ${q.limit + 1}
  `);
  const page = r.rows.slice(0, q.limit);
  const last = page[page.length - 1];
  return {
    items: page.map((a) => ({
      id: a.id, actorType: a.actor_type, actorId: a.actor_id, action: a.action,
      targetType: a.target_type, targetId: a.target_id, metadata: a.metadata, requestId: a.request_id,
      createdAt: new Date(a.created_at).toISOString(),
    })),
    nextCursor: r.rows.length > q.limit && last ? encodeTsCursor(last.created_at_raw, last.id) : null,
  };
}
