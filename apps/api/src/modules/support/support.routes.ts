import { Hono } from 'hono';
import {
  attachmentUploadSchema,
  sendSupportMessageSchema,
  supportIdParamSchema,
  supportMessagesQuerySchema,
} from '@visaitaly/shared';
import { requireSession } from '../../middleware/auth.js';
import { parseOrThrow, jsonBody } from '../../lib/validate.js';
import { AppError } from '../../lib/errors.js';
import { verifyDocumentUrl } from '../../lib/signed-url.js';
import {
  attachmentViewUrl, getThreadView, listMessages, loadAttachmentForUpload, loadAttachmentForView, markThreadRead,
  reserveAttachment, sendMessage,
} from './support.service.js';
import type { AppEnv } from '../../env.js';

/** Mounted at /v1/support — Support Thread (Screen 25). */
export const supportRoutes = new Hono<AppEnv>();
const originOf = (url: string) => new URL(url).origin;
const localeOf = (raw: string | undefined) => (raw && /^[a-z]{2}$/.test(raw) ? raw : 'en');
const idOf = (raw: string | undefined) => parseOrThrow(supportIdParamSchema, { id: raw }).id;

supportRoutes.get('/thread', requireSession, async (c) =>
  c.json(await getThreadView(c.get('db'), c.get('session').userId, localeOf(c.req.query('locale')))),
);

supportRoutes.get('/messages', requireSession, async (c) =>
  c.json(await listMessages(c.get('db'), c.get('session').userId, parseOrThrow(supportMessagesQuerySchema, c.req.query()))),
);

supportRoutes.post('/messages', requireSession, async (c) => {
  const input = parseOrThrow(sendSupportMessageSchema, await jsonBody(c.req.raw));
  return c.json(await sendMessage(c.get('db'), c.get('store'), c.get('session').userId, input), 201);
});

/** Opening the thread: marks admin replies read. */
supportRoutes.post('/read', requireSession, async (c) => {
  await markThreadRead(c.get('db'), c.get('session').userId);
  return c.body(null, 204);
});

supportRoutes.post('/attachments/upload-url', requireSession, async (c) => {
  const input = parseOrThrow(attachmentUploadSchema, await jsonBody(c.req.raw));
  return c.json(
    await reserveAttachment(c.get('db'), c.env.DOCUMENTS_SIGNING_KEY, originOf(c.req.url), c.get('session').userId, input),
  );
});

supportRoutes.get('/attachments/:id', requireSession, async (c) =>
  c.json(await attachmentViewUrl(c.get('db'), c.env.DOCUMENTS_SIGNING_KEY, originOf(c.req.url), c.get('session').userId, idOf(c.req.param('id')))),
);

// ---- capability URLs (no session) — every failure is an opaque 404 ----
supportRoutes.put('/attachments/:id/content', async (c) => {
  const id = idOf(c.req.param('id'));
  if (!(await verifyDocumentUrl(c.env.DOCUMENTS_SIGNING_KEY, 'PUT', id, c.req.query('exp'), c.req.query('sig')))) throw AppError.notFound();
  const a = await loadAttachmentForUpload(c.get('db'), id);
  if (!a) throw AppError.notFound();
  const len = Number(c.req.header('Content-Length'));
  const type = c.req.header('Content-Type')?.split(';')[0]?.trim();
  if (!Number.isInteger(len) || len !== a.size_bytes || type !== a.mime || !c.req.raw.body) throw AppError.uploadRejected();
  await c.get('store').put(a.r2_key, c.req.raw.body, a.mime);
  return c.body(null, 204);
});

supportRoutes.get('/attachments/:id/content', async (c) => {
  const id = idOf(c.req.param('id'));
  if (!(await verifyDocumentUrl(c.env.DOCUMENTS_SIGNING_KEY, 'GET', id, c.req.query('exp'), c.req.query('sig')))) throw AppError.notFound();
  const a = await loadAttachmentForView(c.get('db'), id);
  if (!a) throw AppError.notFound();
  const obj = await c.get('store').get(a.r2_key);
  if (!obj) throw AppError.notFound();
  return c.body(obj.body, 200, {
    'Content-Type': a.mime, 'Content-Length': String(obj.size), 'Content-Disposition': 'inline',
    'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
  });
});
