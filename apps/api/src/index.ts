import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { ErrorCode } from '@visaitaly/shared';
import type { AppEnv } from './env.js';
import { createDb } from './db/client.js';
import { AppError, isAppError } from './lib/errors.js';

import { authRoutes, meRoutes } from './modules/auth/auth.routes.js';
import { deviceRoutes } from './modules/devices/devices.routes.js';
import { legalRoutes } from './modules/legal/legal.routes.js';
import { onboardingRoutes } from './modules/onboarding/onboarding.routes.js';
import { referenceRoutes } from './modules/reference/reference.routes.js';
import { applicantRoutes } from './modules/applicants/applicants.routes.js';

const app = new Hono<AppEnv>();

app.use('*', secureHeaders());

/**
 * The Flutter client is not a browser and sends no Origin, so CORS exists only
 * for the CMS. Keep it explicit rather than '*' — the API serves documents and
 * PII (docs/SECURITY.md).
 */
app.use(
  '/v1/*',
  cors({
    origin: (origin) => (origin?.endsWith('.visaitaly.pk') ? origin : null),
    allowHeaders: ['Authorization', 'Content-Type', 'X-Device-Id'],
    allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    maxAge: 86400,
  }),
);

/** Correlates a client-visible error with the server log. Never a user id. */
app.use('*', async (c, next) => {
  c.set('requestId', crypto.randomUUID());
  await next();
});

/**
 * One pg client per request. Teardown goes to waitUntil so the socket closes
 * after the response is flushed rather than on the measured request path —
 * the 10ms CPU ceiling is the binding constraint (docs/SCALE.md).
 */
app.use('/v1/*', async (c, next) => {
  const { db, close } = createDb(c.env);
  c.set('db', db);
  try {
    await next();
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

// ---------------------------------------------------------------------------
// routes
// ---------------------------------------------------------------------------

app.get('/health', (c) => c.json({ ok: true }));

app.route('/v1/auth', authRoutes);
app.route('/v1/me', meRoutes);
app.route('/v1/devices', deviceRoutes);
app.route('/v1/legal', legalRoutes);
app.route('/v1/onboarding', onboardingRoutes);
app.route('/v1/reference', referenceRoutes);
app.route('/v1/applicants', applicantRoutes);

// ---------------------------------------------------------------------------
// errors
// ---------------------------------------------------------------------------

app.notFound((c) =>
  c.json(
    { error: { code: ErrorCode.NOT_FOUND, message: 'Not found.', requestId: c.get('requestId') } },
    404,
  ),
);

/**
 * The only place an error becomes a response.
 *
 * AppError is expected and maps straight through. Anything else is a bug: it is
 * logged in full server-side and returned as an opaque 500, because unknown
 * errors carry SQL text, connection strings and stack frames
 * (docs/SECURITY.md — errors never leak internals).
 */
app.onError((err, c) => {
  const requestId = c.get('requestId') ?? 'unknown';

  if (isAppError(err)) {
    return c.json(err.toBody(requestId), err.status as 400);
  }

  console.error(
    JSON.stringify({
      level: 'error',
      requestId,
      path: c.req.path,
      method: c.req.method,
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    }),
  );

  return c.json(AppError.internal().toBody(requestId), 500);
});

export default app;
