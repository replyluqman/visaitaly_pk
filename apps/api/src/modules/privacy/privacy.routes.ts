import { Hono } from 'hono';
import { consentsSchema, dataRequestIdParamSchema, deleteAccountSchema } from '@visaitaly/shared';
import { requireSession } from '../../middleware/auth.js';
import { parseOrThrow, jsonBody } from '../../lib/validate.js';
import { AppError } from '../../lib/errors.js';
import { verifyDocumentUrl } from '../../lib/signed-url.js';
import {
  getConsents, getExport, loadExportForDownload, requestDeletion, requestExport, setConsents,
} from './privacy.service.js';
import type { AppEnv } from '../../env.js';

/** Mounted at /v1/account — privacy rights (DATA-PRIVACY.md). */
export const accountRoutes = new Hono<AppEnv>();
const originOf = (url: string) => new URL(url).origin;

accountRoutes.get('/consents', requireSession, async (c) => c.json(await getConsents(c.get('db'), c.get('session').userId)));
accountRoutes.put('/consents', requireSession, async (c) => {
  const input = parseOrThrow(consentsSchema, await jsonBody(c.req.raw));
  return c.json(await setConsents(c.get('db'), c.get('session').userId, input));
});

/** POST /v1/account/data-export — right of access. 202; built by the Cron, announced in the inbox. */
accountRoutes.post('/data-export', requireSession, async (c) => {
  return c.json(await requestExport(c.get('db'), c.get('session').userId), 202);
});

accountRoutes.get('/data-exports/:id', requireSession, async (c) => {
  const { id } = parseOrThrow(dataRequestIdParamSchema, { id: c.req.param('id') });
  return c.json(
    await getExport(c.get('db'), c.env.DOCUMENTS_SIGNING_KEY, originOf(c.req.url), c.get('session').userId, id),
  );
});

/** Capability URL (no session) — short-lived, GET-scoped, attachment, never cached. */
accountRoutes.get('/data-exports/:id/content', async (c) => {
  const { id } = parseOrThrow(dataRequestIdParamSchema, { id: c.req.param('id') });
  const ok = await verifyDocumentUrl(c.env.DOCUMENTS_SIGNING_KEY, 'GET', id, c.req.query('exp'), c.req.query('sig'));
  if (!ok) throw AppError.notFound();
  const key = await loadExportForDownload(c.get('db'), id);
  if (!key) throw AppError.notFound();
  const obj = await c.get('store').get(key);
  if (!obj) throw AppError.notFound();
  return c.body(obj.body, 200, {
    'Content-Type': 'application/json',
    'Content-Length': String(obj.size),
    'Content-Disposition': 'attachment; filename="visaitaly-data-export.json"',
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
  });
});

/**
 * DELETE /v1/account — right to erasure. Needs `{confirm: true}` AND a recent sign-in
 * (REAUTH_REQUIRED otherwise). 202: the account is unusable immediately, data erased within minutes.
 */
accountRoutes.delete('/', requireSession, async (c) => {
  parseOrThrow(deleteAccountSchema, await jsonBody(c.req.raw));
  return c.json(await requestDeletion(c.get('db'), c.get('session').userId, c.get('auth')), 202);
});
