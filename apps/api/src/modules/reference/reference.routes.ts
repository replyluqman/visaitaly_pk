import { Hono } from 'hono';
import { requireSession } from '../../middleware/auth.js';
import { listRelationships } from './reference.service.js';
import type { AppEnv } from '../../env.js';

export const referenceRoutes = new Hono<AppEnv>();

referenceRoutes.use('*', requireSession);

/**
 * GET /v1/reference/relationships — Screens §6 picker.
 * CMS-driven so a new relation ships without an app release (PRD §6).
 * Client should cache this; it changes rarely (PRD §4 client-cache-first).
 */
referenceRoutes.get('/relationships', async (c) => {
  const locale = c.req.query('locale');
  const resolved = locale && /^[a-z]{2}$/.test(locale) ? locale : 'en';
  return c.json({ relationships: await listRelationships(c.get('db'), resolved) });
});
