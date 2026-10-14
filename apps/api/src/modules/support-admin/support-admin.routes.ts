import { Hono } from 'hono';
import {
  AdminScope,
  adminReplySchema,
  adminThreadListSchema,
  assignSchema,
  cmsIdParamSchema,
  createCannedSchema,
  patchCannedSchema,
  supportMessagesQuerySchema,
} from '@visaitaly/shared';
import { requireAdmin } from '../../middleware/admin.js';
import { parseOrThrow, jsonBody } from '../../lib/validate.js';
import {
  adminAttachmentUrl, assignThread, createCanned, getThreadDetail, listCanned, listThreads, patchCanned,
  replyToThread, setThreadState, supportSummary,
} from './support-admin.service.js';
import type { AppEnv } from '../../env.js';

const idOf = (raw: string | undefined) => parseOrThrow(cmsIdParamSchema, { id: raw }).id;
const read = requireAdmin(AdminScope.SUPPORT_MANAGE, 'read');
const write = requireAdmin(AdminScope.SUPPORT_MANAGE, 'write');

/** Mounted at /v1/admin — Support Inbox (Screen 35). Scope: support_manage (`read_only` may read). */
export const supportAdminRoutes = new Hono<AppEnv>();

supportAdminRoutes.get('/support/summary', read, async (c) => c.json(await supportSummary(c.get('db'))));

supportAdminRoutes.get('/support/threads', read, async (c) =>
  c.json(await listThreads(c.get('db'), c.get('admin'), parseOrThrow(adminThreadListSchema, c.req.query()))),
);
supportAdminRoutes.get('/support/threads/:id', read, async (c) =>
  c.json(await getThreadDetail(c.get('db'), idOf(c.req.param('id')), parseOrThrow(supportMessagesQuerySchema, c.req.query()))),
);
supportAdminRoutes.post('/support/threads/:id/messages', write, async (c) => {
  const input = parseOrThrow(adminReplySchema, await jsonBody(c.req.raw));
  return c.json(await replyToThread(c.get('db'), c.get('admin'), idOf(c.req.param('id')), input, c.get('requestId')), 201);
});
supportAdminRoutes.post('/support/threads/:id/assign', write, async (c) => {
  const { adminId } = parseOrThrow(assignSchema, await jsonBody(c.req.raw));
  return c.json(await assignThread(c.get('db'), c.get('admin'), idOf(c.req.param('id')), adminId, c.get('requestId')));
});
supportAdminRoutes.post('/support/threads/:id/close', write, async (c) =>
  c.json(await setThreadState(c.get('db'), c.get('admin'), idOf(c.req.param('id')), 'close', c.get('requestId'))),
);
supportAdminRoutes.post('/support/threads/:id/reopen', write, async (c) =>
  c.json(await setThreadState(c.get('db'), c.get('admin'), idOf(c.req.param('id')), 'reopen', c.get('requestId'))),
);
supportAdminRoutes.get('/support/attachments/:id/url', read, async (c) =>
  c.json(await adminAttachmentUrl(c.get('db'), c.get('admin'), c.env.DOCUMENTS_SIGNING_KEY, new URL(c.req.url).origin, idOf(c.req.param('id')), c.get('requestId'))),
);

supportAdminRoutes.get('/canned-responses', read, async (c) => c.json(await listCanned(c.get('db'), c.req.query('active') === 'true')));
supportAdminRoutes.post('/canned-responses', write, async (c) => {
  const input = parseOrThrow(createCannedSchema, await jsonBody(c.req.raw));
  return c.json(await createCanned(c.get('db'), c.get('admin'), input, c.get('requestId')), 201);
});
supportAdminRoutes.patch('/canned-responses/:id', write, async (c) => {
  const input = parseOrThrow(patchCannedSchema, await jsonBody(c.req.raw));
  return c.json(await patchCanned(c.get('db'), c.get('admin'), idOf(c.req.param('id')), input, c.get('requestId')));
});
