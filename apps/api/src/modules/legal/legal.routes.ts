import { Hono } from 'hono';
import { acceptLegalSchema, legalDocTypeParamSchema } from '@visaitaly/shared';
import { requireSession } from '../../middleware/auth.js';
import { parseOrThrow, jsonBody } from '../../lib/validate.js';
import { listCurrentLegal, getCurrentLegalDocument, acceptLegal } from './legal.service.js';
import type { AppEnv } from '../../env.js';

export const legalRoutes = new Hono<AppEnv>();

legalRoutes.use('*', requireSession);

/**
 * Urdu is gated behind app_config.urdu_content_complete (PRD §11a), so 'en' is
 * the only locale with published content today. Unknown locales fall back per
 * document rather than 404ing.
 */
const localeOf = (raw: string | undefined) => (raw && /^[a-z]{2}$/.test(raw) ? raw : 'en');

/** GET /v1/legal/current — metadata + acceptance state, no bodies. */
legalRoutes.get('/current', async (c) => {
  const { userId } = c.get('session');
  return c.json(await listCurrentLegal(c.get('db'), userId, localeOf(c.req.query('locale'))));
});

/** GET /v1/legal/current/:docType — full text for the Disclaimer Gate. */
legalRoutes.get('/current/:docType', async (c) => {
  const { userId } = c.get('session');
  const { docType } = parseOrThrow(legalDocTypeParamSchema, { docType: c.req.param('docType') });
  return c.json(
    await getCurrentLegalDocument(c.get('db'), userId, docType, localeOf(c.req.query('locale'))),
  );
});

/** POST /v1/legal/accept — blocking accept, version-stamped (PRD §18). */
legalRoutes.post('/accept', async (c) => {
  const { userId, deviceId } = c.get('session');
  const input = parseOrThrow(acceptLegalSchema, await jsonBody(c.req.raw));
  return c.json(
    await acceptLegal(c.get('db'), userId, deviceId, input.versionIds, input.appVersion),
  );
});
