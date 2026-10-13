import { Hono } from 'hono';
import { requireSession } from '../../middleware/auth.js';
import { getToday } from './today.service.js';
import type { AppEnv } from '../../env.js';

export const todayRoutes = new Hono<AppEnv>();
todayRoutes.use('*', requireSession);

/** GET /v1/today — Screen 9. Reads next_actions; never computes. Premium only (PRD §8). */
todayRoutes.get('/', async (c) => {
  const { userId } = c.get('session');
  const locale = c.req.query('locale');
  return c.json(await getToday(c.get('db'), userId, locale && /^[a-z]{2}$/.test(locale) ? locale : 'en'));
});
