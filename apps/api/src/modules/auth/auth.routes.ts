import { Hono } from 'hono';
import { registerSessionSchema } from '@visaitaly/shared';
import { requireAuth, requireSession } from '../../middleware/auth.js';
import { parseOrThrow, jsonBody } from '../../lib/validate.js';
import { registerSession, getMe } from './auth.service.js';
import type { AppEnv } from '../../env.js';

export const authRoutes = new Hono<AppEnv>();

/**
 * POST /v1/auth/session
 * Called immediately after every successful Firebase sign-in.
 * Creates the account on first login, registers the device, applies the
 * 2-device rule. Idempotent — safe to retry on network failure.
 */
authRoutes.post('/session', requireAuth, async (c) => {
  const input = parseOrThrow(registerSessionSchema, await jsonBody(c.req.raw));
  // Token was verified once by requireAuth; reuse it.
  const result = await registerSession(c.get('db'), c.get('auth'), input);
  return c.json(result, result.session.isNewUser ? 201 : 200);
});

/**
 * GET /v1/me
 *
 * Mounted as its own router at /v1/me rather than /v1/auth/me: the payload is
 * the app-launch snapshot — identity, entitlement, onboarding state and device
 * count — not an auth operation. Grouping it under /auth would imply the
 * client re-authenticates on every launch, which it does not.
 *
 * Entitlement is resolved from Neon on every launch (PRD §5). This is also the
 * request that returns DEVICE_EVICTED to a dropped device, so it is the first
 * thing the client calls and the only one it must handle before rendering.
 */
export const meRoutes = new Hono<AppEnv>();

meRoutes.get('/', requireSession, async (c) => {
  const { userId, deviceId } = c.get('session');
  return c.json(await getMe(c.get('db'), userId, deviceId));
});
