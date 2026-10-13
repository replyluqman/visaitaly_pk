import { Hono } from 'hono';
import { deviceIdParamSchema } from '@visaitaly/shared';
import { requireSession } from '../../middleware/auth.js';
import { parseOrThrow } from '../../lib/validate.js';
import { listActiveDevices, signOutDevice } from './devices.service.js';
import type { AppEnv } from '../../env.js';

export const deviceRoutes = new Hono<AppEnv>();

deviceRoutes.use('*', requireSession);

/** GET /v1/devices — Account screen active-sessions list (max 2). */
deviceRoutes.get('/', async (c) => {
  const { userId, deviceId } = c.get('session');
  return c.json({ devices: await listActiveDevices(c.get('db'), userId, deviceId) });
});

/** DELETE /v1/devices/:deviceId — remote sign-out from the Account screen. */
deviceRoutes.delete('/:deviceId', async (c) => {
  const { userId } = c.get('session');
  const { deviceId } = parseOrThrow(deviceIdParamSchema, { deviceId: c.req.param('deviceId') });
  await signOutDevice(c.get('db'), userId, deviceId);
  return c.body(null, 204);
});
