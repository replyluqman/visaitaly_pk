import { Hono } from 'hono';
import {
  notificationIdParamSchema,
  notificationListQuerySchema,
  notificationPreferencesSchema,
  readAllSchema,
} from '@visaitaly/shared';
import { requireSession } from '../../middleware/auth.js';
import { parseOrThrow, jsonBody, optionalJsonBody } from '../../lib/validate.js';
import {
  getPreferences, listNotifications, markAllRead, markRead, setPreferences, unreadCount,
} from './notifications.service.js';
import type { AppEnv } from '../../env.js';

/** Mounted at /v1/notifications — Notification Center (Screen 13). */
export const notificationRoutes = new Hono<AppEnv>();
notificationRoutes.use('*', requireSession);

notificationRoutes.get('/', async (c) => {
  const { userId } = c.get('session');
  return c.json(await listNotifications(c.get('db'), userId, parseOrThrow(notificationListQuerySchema, c.req.query())));
});

/** The bell badge — one indexed count. Registered before /:id so "unread-count" is not an id. */
notificationRoutes.get('/unread-count', async (c) => c.json(await unreadCount(c.get('db'), c.get('session').userId)));

notificationRoutes.post('/read-all', async (c) => {
  const { tab } = parseOrThrow(readAllSchema, await optionalJsonBody(c.req.raw));
  await markAllRead(c.get('db'), c.get('session').userId, tab);
  return c.body(null, 204);
});

notificationRoutes.post('/:id/read', async (c) => {
  const { id } = parseOrThrow(notificationIdParamSchema, { id: c.req.param('id') });
  await markRead(c.get('db'), c.get('session').userId, id);
  return c.body(null, 204);
});

/** Mounted at /v1/notification-preferences. */
export const notificationPreferenceRoutes = new Hono<AppEnv>();
notificationPreferenceRoutes.use('*', requireSession);
notificationPreferenceRoutes.get('/', async (c) => c.json(await getPreferences(c.get('db'), c.get('session').userId)));
notificationPreferenceRoutes.put('/', async (c) => {
  const input = parseOrThrow(notificationPreferencesSchema, await jsonBody(c.req.raw));
  return c.json(await setPreferences(c.get('db'), c.get('session').userId, input));
});
