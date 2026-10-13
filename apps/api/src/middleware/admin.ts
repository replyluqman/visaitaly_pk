import { sql } from 'drizzle-orm';
import { createMiddleware } from 'hono/factory';
import { AdminScope } from '@visaitaly/shared';
import type { AppEnv } from '../env.js';
import { AppError } from '../lib/errors.js';
import { verifyAdminIdToken } from '../lib/firebase.js';

type AdminRow = {
  id: string;
  email: string;
  is_super: boolean;
  status: 'active' | 'disabled';
  scopes: string[];
};

/**
 * Authenticates an admin and checks one screen's scope (ADR 0012, PRD §16).
 *
 *   access 'write' — super, or the screen's own scope
 *   access 'read'  — super, the screen's own scope, or `read_only`
 *   access 'any'   — any active admin (their own profile, the audit viewer's lower bound)
 *
 * Identity, status and scopes come from one query per request, so disabling an admin or
 * revoking a scope bites immediately. Denial is 403 ADMIN_FORBIDDEN: admin routes are not an
 * id-enumeration surface (user-owned data still 404s).
 */
export const requireAdmin = (scope: AdminScope | null, access: 'read' | 'write' | 'any') =>
  createMiddleware<AppEnv>(async (c, next) => {
    const token = await verifyAdminIdToken(c.req.header('Authorization'), c.env);
    const db = c.get('db');

    const find = () =>
      db.execute<AdminRow>(sql`
        SELECT a.id, a.email, a.is_super, a.status,
               coalesce(array_agg(p.scope) FILTER (WHERE p.scope IS NOT NULL), '{}') AS scopes
          FROM admins a
          LEFT JOIN admin_permissions p ON p.admin_id = a.id
         WHERE a.firebase_uid = ${token.uid}
         GROUP BY a.id
      `);

    let row = (await find()).rows[0];

    // First login: link the pre-registered row by VERIFIED email. A pre-registered admin has
    // no firebase_uid yet; nobody can create an admin by signing in (no self-signup path).
    if (!row && token.email && token.emailVerified) {
      const linked = await db.execute(sql`
        UPDATE admins SET firebase_uid = ${token.uid}, last_login_at = now()
         WHERE email = ${token.email} AND firebase_uid IS NULL AND status = 'active'
        RETURNING id
      `);
      if (linked.rows.length > 0) row = (await find()).rows[0];
    }

    if (!row || row.status !== 'active') throw AppError.adminForbidden();
    if (c.env.ADMIN_REQUIRE_MFA === 'true' && !token.mfa) throw AppError.adminMfaRequired();

    const scopes = new Set(row.scopes);
    const allowed =
      row.is_super ||
      access === 'any' ||
      (scope !== null && scopes.has(scope)) ||
      (access === 'read' && scopes.has(AdminScope.READ_ONLY));
    if (!allowed) throw AppError.adminForbidden();

    c.set('admin', { id: row.id, email: row.email, isSuper: row.is_super, scopes });
    await next();
  });

/** Only `super_admin` (PRD §16: the only role that can create admins and assign permissions). */
export const requireSuper = createMiddleware<AppEnv>(async (c, next) => {
  await requireAdmin(null, 'any')(c, async () => {});
  if (!c.get('admin').isSuper) throw AppError.adminForbidden();
  await next();
});
