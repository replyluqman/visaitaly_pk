import { Hono } from 'hono';
import { eligibilityAnswersSchema } from '@visaitaly/shared';
import { parseOrThrow, jsonBody } from '../../lib/validate.js';
import { evaluate, getQuestionSet } from './eligibility.service.js';
import type { AppEnv } from '../../env.js';

/** Pre-auth surfaces. No requireSession — rate limiting is an edge rule (docs/SECURITY.md). */
export const publicRoutes = new Hono<AppEnv>();

const localeOf = (raw: string | undefined) => (raw && /^[a-z]{2}$/.test(raw) ? raw : 'en');

/** GET /v1/public/eligibility-check — question set; cacheable at the edge for an hour. */
publicRoutes.get('/eligibility-check', async (c) => {
  const body = await getQuestionSet(c.get('db'), localeOf(c.req.query('locale')));
  c.header('Cache-Control', 'public, max-age=3600');
  return c.json(body);
});

/** POST /v1/public/eligibility-check — stateless orientation. Never cached, never stored. */
publicRoutes.post('/eligibility-check', async (c) => {
  const input = parseOrThrow(eligibilityAnswersSchema, await jsonBody(c.req.raw));
  const result = await evaluate(c.get('db'), input, localeOf(c.req.query('locale')));
  c.header('Cache-Control', 'no-store');
  return c.json(result);
});
