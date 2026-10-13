import { Hono } from 'hono';
import {
  documentIdParamSchema,
  documentListQuerySchema,
  uploadUrlSchema,
} from '@visaitaly/shared';
import { requireSession } from '../../middleware/auth.js';
import { parseOrThrow, jsonBody } from '../../lib/validate.js';
import { AppError } from '../../lib/errors.js';
import { verifyDocumentUrl } from '../../lib/signed-url.js';
import {
  completeUpload,
  createUpload,
  deleteDocument,
  getDocumentWithUrl,
  listDocuments,
  loadForUpload,
  loadForView,
} from './documents.service.js';
import type { AppEnv } from '../../env.js';

export const documentRoutes = new Hono<AppEnv>();

const idOf = (raw: string | undefined) => parseOrThrow(documentIdParamSchema, { id: raw }).id;
const originOf = (url: string) => new URL(url).origin;

// ---- session-authenticated metadata API ----------------------------------

/** POST /v1/documents/upload-url — step 1. Reserves quota; returns a short-lived PUT URL. */
documentRoutes.post('/upload-url', requireSession, async (c) => {
  const { userId } = c.get('session');
  const input = parseOrThrow(uploadUrlSchema, await jsonBody(c.req.raw));
  return c.json(
    await createUpload(c.get('db'), c.env.DOCUMENTS_SIGNING_KEY, originOf(c.req.url), userId, input),
  );
});

/** GET /v1/documents — Screen 14. */
documentRoutes.get('/', requireSession, async (c) => {
  const { userId } = c.get('session');
  return c.json(await listDocuments(c.get('db'), userId, parseOrThrow(documentListQuerySchema, c.req.query())));
});

/** POST /v1/documents/:id/complete — step 2. Verifies size + magic bytes, then activates. */
documentRoutes.post('/:id/complete', requireSession, async (c) => {
  const { userId } = c.get('session');
  return c.json(await completeUpload(c.get('db'), c.get('store'), userId, idOf(c.req.param('id'))));
});

/** GET /v1/documents/:id — metadata + short-lived view URL. */
documentRoutes.get('/:id', requireSession, async (c) => {
  const { userId } = c.get('session');
  return c.json(
    await getDocumentWithUrl(
      c.get('db'), c.env.DOCUMENTS_SIGNING_KEY, originOf(c.req.url), userId, idOf(c.req.param('id')),
    ),
  );
});

/** DELETE /v1/documents/:id — removes the R2 object, then the row. */
documentRoutes.delete('/:id', requireSession, async (c) => {
  const { userId } = c.get('session');
  await deleteDocument(c.get('db'), c.get('store'), userId, idOf(c.req.param('id')));
  return c.body(null, 204);
});

// ---- capability URLs for the bytes (no session: an <Image> widget cannot send headers) ----
// Every failure here is an opaque 404 so the endpoint is not an oracle for ids or signatures.

/** PUT /v1/documents/:id/content?exp&sig — the upload itself. */
documentRoutes.put('/:id/content', async (c) => {
  const id = idOf(c.req.param('id'));
  const ok = await verifyDocumentUrl(
    c.env.DOCUMENTS_SIGNING_KEY, 'PUT', id, c.req.query('exp'), c.req.query('sig'),
  );
  if (!ok) throw AppError.notFound();
  const doc = await loadForUpload(c.get('db'), id);
  if (!doc) throw AppError.notFound();

  // The length and type are checked BEFORE a byte is read; complete() re-verifies from storage.
  const len = Number(c.req.header('Content-Length'));
  const type = c.req.header('Content-Type')?.split(';')[0]?.trim();
  if (!Number.isInteger(len) || len !== doc.size_bytes || type !== doc.mime || !c.req.raw.body) {
    throw AppError.uploadRejected();
  }
  await c.get('store').put(doc.r2_key, c.req.raw.body, doc.mime);
  return c.body(null, 204);
});

/** GET /v1/documents/:id/content?exp&sig — the bytes, streamed. Never cached, never sniffed. */
documentRoutes.get('/:id/content', async (c) => {
  const id = idOf(c.req.param('id'));
  const ok = await verifyDocumentUrl(
    c.env.DOCUMENTS_SIGNING_KEY, 'GET', id, c.req.query('exp'), c.req.query('sig'),
  );
  if (!ok) throw AppError.notFound();
  const doc = await loadForView(c.get('db'), id);
  if (!doc) throw AppError.notFound();
  const obj = await c.get('store').get(doc.r2_key);
  if (!obj) throw AppError.notFound();
  return c.body(obj.body, 200, {
    'Content-Type': doc.mime,
    'Content-Length': String(obj.size),
    'Content-Disposition': 'inline',
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
  });
});
