import { Hono } from 'hono';
import {
  AdminScope,
  cmsIdParamSchema,
  cmsListQuerySchema,
  createRequirementSchema,
  createSourceSchema,
  patchRequirementSchema,
  patchSourceSchema,
  requirementActionSchema,
  requirementListQuerySchema,
  resolveFlagSchema,
} from '@visaitaly/shared';
import { requireAdmin } from '../../middleware/admin.js';
import { parseOrThrow, jsonBody } from '../../lib/validate.js';
import {
  applyRequirementAction, createRequirement, createSource, getRequirement, listFlags, listRequirementVersions,
  listRequirements, listSources, patchRequirement, patchSource, resolveFlag, verificationSummary,
} from './cms.service.js';
import type { AppEnv } from '../../env.js';

const SCOPE = AdminScope.VERIFICATION_MANAGE;
const idOf = (raw: string | undefined) => parseOrThrow(cmsIdParamSchema, { id: raw }).id;
const read = requireAdmin(SCOPE, 'read');
const write = requireAdmin(SCOPE, 'write');

/** Mounted at /v1/admin — Content / Requirement CMS (Screen 39) and Hash-Change Flags (Screen 40). */
export const cmsRoutes = new Hono<AppEnv>();

// ---- sources ----
cmsRoutes.get('/sources', read, async (c) => {
  const q = parseOrThrow(cmsListQuerySchema, c.req.query());
  return c.json(await listSources(c.get('db'), q.cursor, q.limit));
});
cmsRoutes.post('/sources', write, async (c) => {
  const input = parseOrThrow(createSourceSchema, await jsonBody(c.req.raw));
  return c.json(await createSource(c.get('db'), c.get('admin'), input, c.get('requestId')), 201);
});
cmsRoutes.patch('/sources/:id', write, async (c) => {
  const input = parseOrThrow(patchSourceSchema, await jsonBody(c.req.raw));
  return c.json(await patchSource(c.get('db'), c.get('admin'), idOf(c.req.param('id')), input, c.get('requestId')));
});

// ---- hash-change flags ----
cmsRoutes.get('/source-flags', read, async (c) =>
  c.json(await listFlags(c.get('db'), parseOrThrow(cmsListQuerySchema, c.req.query()))),
);
cmsRoutes.post('/source-flags/:id/resolve', write, async (c) => {
  const input = parseOrThrow(resolveFlagSchema, await jsonBody(c.req.raw));
  return c.json(await resolveFlag(c.get('db'), c.get('admin'), idOf(c.req.param('id')), input, c.get('requestId')));
});

// ---- requirements ----
cmsRoutes.get('/requirements', read, async (c) =>
  c.json(await listRequirements(c.get('db'), parseOrThrow(requirementListQuerySchema, c.req.query()))),
);
cmsRoutes.post('/requirements', write, async (c) => {
  const input = parseOrThrow(createRequirementSchema, await jsonBody(c.req.raw));
  return c.json(await createRequirement(c.get('db'), c.get('admin'), input, c.get('requestId')), 201);
});
cmsRoutes.get('/requirements/:id', read, async (c) => c.json(await getRequirement(c.get('db'), idOf(c.req.param('id')))));
cmsRoutes.get('/requirements/:id/versions', read, async (c) =>
  c.json({ items: await listRequirementVersions(c.get('db'), idOf(c.req.param('id'))) }),
);
cmsRoutes.patch('/requirements/:id', write, async (c) => {
  const input = parseOrThrow(patchRequirementSchema, await jsonBody(c.req.raw));
  return c.json(await patchRequirement(c.get('db'), c.get('admin'), idOf(c.req.param('id')), input, c.get('requestId')));
});
cmsRoutes.post('/requirements/:id/actions', write, async (c) => {
  const input = parseOrThrow(requirementActionSchema, await jsonBody(c.req.raw));
  return c.json(await applyRequirementAction(c.get('db'), c.get('admin'), idOf(c.req.param('id')), input, c.get('requestId')));
});

/** Public — How We Verify (Screen 15). Mounted at /v1/public. */
export const verificationPublicRoutes = new Hono<AppEnv>();
verificationPublicRoutes.get('/verification-summary', async (c) => {
  const locale = c.req.query('locale');
  const body = await verificationSummary(c.get('db'), locale && /^[a-z]{2}$/.test(locale) ? locale : 'en');
  c.header('Cache-Control', 'public, max-age=300');
  return c.json(body);
});
