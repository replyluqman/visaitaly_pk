import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { ErrorCode } from '@visaitaly/shared';
import type { AppEnv, Env } from './env.js';
import { createDb } from './db/client.js';
import { AppError, isAppError } from './lib/errors.js';
import { createR2Store, type ObjectStore } from './lib/storage.js';

import { authRoutes, meRoutes } from './modules/auth/auth.routes.js';
import { deviceRoutes } from './modules/devices/devices.routes.js';
import { legalRoutes } from './modules/legal/legal.routes.js';
import { onboardingRoutes } from './modules/onboarding/onboarding.routes.js';
import { referenceRoutes } from './modules/reference/reference.routes.js';
import { applicantRoutes } from './modules/applicants/applicants.routes.js';
import { publicRoutes } from './modules/eligibility/eligibility.routes.js';
import { documentRoutes } from './modules/documents/documents.routes.js';
import { purgeStaleDocuments } from './modules/documents/documents.service.js';
import { refreshNextActions } from './modules/today/today.service.js';
import { cmsRoutes, verificationPublicRoutes } from './modules/cms/cms.routes.js';
import { sweepSources } from './modules/cms/cms.service.js';
import { adminRoutes } from './modules/admin/admin.routes.js';
import { todayRoutes } from './modules/today/today.routes.js';
import { applicantCaseRoutes, checklistRoutes } from './modules/checklist/checklist.routes.js';

export interface AppDeps {
  createStore?: (env: Env) => ObjectStore;
}

export function createApp(deps: AppDeps = {}): Hono<AppEnv> {
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
      allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      maxAge: 86400,
    }),
  );

  /** Correlates a client-visible error with the server log. Never a user id. */
  app.use('*', async (c, next) => {
    const requestId = crypto.randomUUID();
    c.set('requestId', requestId);
    await next();
    c.header('X-Request-Id', requestId);
  });

  /** Object storage. Injected so tests run the real routes against an in-memory store. */
  app.use('/v1/*', async (c, next) => {
    c.set('store', deps.createStore ? deps.createStore(c.env) : createR2Store(c.env));
    await next();
  });

  /**
   * One pg client per request. Teardown goes to waitUntil so the socket closes
   * after the response is flushed rather than on the measured request path —
   * the 10ms CPU ceiling is the binding constraint (docs/SCALE.md).
   */
  app.use('/v1/*', async (c, next) => {
    const { db, close } = await createDb(c.env);
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

  app.route('/v1/public', publicRoutes);
  app.route('/v1/auth', authRoutes);
  app.route('/v1/me', meRoutes);
  app.route('/v1/devices', deviceRoutes);
  app.route('/v1/legal', legalRoutes);
  app.route('/v1/onboarding', onboardingRoutes);
  app.route('/v1/reference', referenceRoutes);
  app.route('/v1/applicants', applicantRoutes);
  app.route('/v1/applicants', applicantCaseRoutes);
  app.route('/v1/checklist', checklistRoutes);
  app.route('/v1/documents', documentRoutes);
  app.route('/v1/today', todayRoutes);
  app.route('/v1/admin', adminRoutes);
  app.route('/v1/admin', cmsRoutes);
  app.route('/v1/public', verificationPublicRoutes);

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
      return c.json(err.toBody(requestId), err.status);
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

  return app;
}

const app = createApp();

/** 02:00 PKT (UTC+5) = 21:00 UTC. Every other tick is the frequent job set. Must match wrangler.toml. */
const DAILY_SWEEP_CRON = '0 21 * * *';

/**
 * Cron Worker entry (wrangler `[triggers] crons`). Everything slow lives here, never on a user
 * request (PRD §4, §15): the Today materialisation and document retention. Each job is
 * independent — one failing must not starve the other — and failures are logged, not thrown,
 * so the next tick retries.
 */
async function scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
  const job = async () => {
    const { db, close } = await createDb(env);
    try {
      const jobs: Array<[string, () => Promise<unknown>]> =
        event.cron === DAILY_SWEEP_CRON
          ? [['source_hash_sweep', () => sweepSources(db)]]
          : [
              ['next_actions', () => refreshNextActions(db)],
              ['document_retention', () => purgeStaleDocuments(db, createR2Store(env))],
            ];
      for (const [name, run] of jobs) {
        try {
          console.log(JSON.stringify({ level: 'info', job: name, result: await run() }));
        } catch (err) {
          console.error(
            JSON.stringify({ level: 'error', job: name, message: err instanceof Error ? err.message : String(err) }),
          );
        }
      }
    } finally {
      await close();
    }
  };
  ctx.waitUntil(job());
}

export default { fetch: app.fetch.bind(app), scheduled };
