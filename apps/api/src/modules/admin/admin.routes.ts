import { Hono } from 'hono';
import {
  adminIdParamSchema,
  auditQuerySchema,
  createAdminSchema,
  patchAdminSchema,
} from '@visaitaly/shared';
import { requireAdmin, requireSuper } from '../../middleware/admin.js';
import { parseOrThrow, jsonBody } from '../../lib/validate.js';
import {
  createAdmin,
  getAdminProfile,
  listAdmins,
  listAudit,
  patchAdmin,
} from './admin.service.js';
import type { AppEnv } from '../../env.js';

/** Everything under /v1/admin. Authenticated against the ADMIN Firebase project (ADR 0012). */
export const adminRoutes = new Hono<AppEnv>();

const pageQuery = (raw: Record<string, string>) => {
  const limit = raw.limit === undefined ? 50 : Number(raw.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    parseOrThrow(auditQuerySchema, { limit: raw.limit });
  }
  return { cursor: raw.cursor, limit };
};

/** GET /v1/admin/me — Screen 30/31: who am I, what may I see. */
adminRoutes.get('/me', requireAdmin(null, 'any'), async (c) =>
  c.json({ admin: await getAdminProfile(c.get('db'), c.get('admin').id) }),
);

/** GET /v1/admin/admins — Screen 32 (super admin). */
adminRoutes.get('/admins', requireSuper, async (c) => {
  const { cursor, limit } = pageQuery(c.req.query());
  return c.json(await listAdmins(c.get('db'), cursor, limit));
});

/** POST /v1/admin/admins — pre-register an admin; the person links by signing in with that email. */
adminRoutes.post('/admins', requireSuper, async (c) => {
  const input = parseOrThrow(createAdminSchema, await jsonBody(c.req.raw));
  return c.json(await createAdmin(c.get('db'), c.get('admin'), input, c.get('requestId')), 201);
});

/** PATCH /v1/admin/admins/:id — rename, enable/disable, promote/demote, replace scopes. */
adminRoutes.patch('/admins/:id', requireSuper, async (c) => {
  const { id } = parseOrThrow(adminIdParamSchema, { id: c.req.param('id') });
  const input = parseOrThrow(patchAdminSchema, await jsonBody(c.req.raw));
  return c.json(await patchAdmin(c.get('db'), c.get('admin'), id, input, c.get('requestId')));
});

/** GET /v1/admin/audit-log — Screen 45 (any admin: "read_only and above"). */
adminRoutes.get('/audit-log', requireAdmin(null, 'any'), async (c) =>
  c.json(await listAudit(c.get('db'), parseOrThrow(auditQuerySchema, c.req.query()))),
);
