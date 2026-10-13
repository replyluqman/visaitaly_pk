import { Hono } from 'hono';
import {
  AdminScope,
  cmsIdParamSchema,
  createLegalVersionSchema,
  legalListQuerySchema,
  lookupQuerySchema,
  patchLegalVersionSchema,
} from '@visaitaly/shared';
import { requireAdmin } from '../../middleware/admin.js';
import { parseOrThrow, jsonBody } from '../../lib/validate.js';
import {
  createLegalVersion, listAcceptances, listLegalVersions, lookupCase, patchLegalVersion, publishLegalVersion,
} from './legal-admin.service.js';
import type { AppEnv } from '../../env.js';

const idOf = (raw: string | undefined) => parseOrThrow(cmsIdParamSchema, { id: raw }).id;
const read = requireAdmin(AdminScope.LEGAL_MANAGE, 'read');
const write = requireAdmin(AdminScope.LEGAL_MANAGE, 'write');

/** Mounted at /v1/admin — Legal version manager (Screen 44) and Case lookup (Screen 36). */
export const legalAdminRoutes = new Hono<AppEnv>();

legalAdminRoutes.get('/legal-versions', read, async (c) =>
  c.json(await listLegalVersions(c.get('db'), parseOrThrow(legalListQuerySchema, c.req.query()))),
);
legalAdminRoutes.post('/legal-versions', write, async (c) => {
  const input = parseOrThrow(createLegalVersionSchema, await jsonBody(c.req.raw));
  return c.json(await createLegalVersion(c.get('db'), c.get('admin'), input, c.get('requestId')), 201);
});
legalAdminRoutes.patch('/legal-versions/:id', write, async (c) => {
  const input = parseOrThrow(patchLegalVersionSchema, await jsonBody(c.req.raw));
  return c.json(await patchLegalVersion(c.get('db'), c.get('admin'), idOf(c.req.param('id')), input, c.get('requestId')));
});
legalAdminRoutes.post('/legal-versions/:id/publish', write, async (c) =>
  c.json(await publishLegalVersion(c.get('db'), c.get('admin'), idOf(c.req.param('id')), c.get('requestId'))),
);
legalAdminRoutes.get('/legal-versions/:id/acceptances', read, async (c) => {
  const q = parseOrThrow(legalListQuerySchema, c.req.query());
  return c.json(await listAcceptances(c.get('db'), c.get('admin'), idOf(c.req.param('id')), q.cursor, q.limit, c.get('requestId')));
});

/** GET /v1/admin/lookup?email= | ?userId= — "read_only and above" = any active admin; always audited. */
legalAdminRoutes.get('/lookup', requireAdmin(null, 'any'), async (c) => {
  const q = parseOrThrow(lookupQuerySchema, c.req.query());
  return c.json(await lookupCase(c.get('db'), c.get('admin'), q, c.get('requestId')));
});
