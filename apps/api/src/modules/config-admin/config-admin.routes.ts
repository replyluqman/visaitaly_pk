import { Hono } from 'hono';
import { AdminScope, configKeyParamSchema, putConfigSchema } from '@visaitaly/shared';
import { requireAdmin } from '../../middleware/admin.js';
import { parseOrThrow, jsonBody } from '../../lib/validate.js';
import { adminOverview, listConfig, putConfig } from './config-admin.service.js';
import type { AppEnv } from '../../env.js';

/** Mounted at /v1/admin — Pricing / CMS config (Screen 43) and Admin home (Screen 31). */
export const configAdminRoutes = new Hono<AppEnv>();

configAdminRoutes.get('/overview', requireAdmin(null, 'any'), async (c) => c.json(await adminOverview(c.get('db'), c.get('admin'))));

configAdminRoutes.get('/config', requireAdmin(AdminScope.PRICING_CONFIG, 'read'), async (c) => c.json({ items: await listConfig(c.get('db')) }));

configAdminRoutes.put('/config/:key', requireAdmin(AdminScope.PRICING_CONFIG, 'write'), async (c) => {
  const { key } = parseOrThrow(configKeyParamSchema, { key: c.req.param('key') });
  const { value } = parseOrThrow(putConfigSchema, await jsonBody(c.req.raw));
  return c.json(await putConfig(c.get('db'), c.get('admin'), key, value, c.get('requestId')));
});
