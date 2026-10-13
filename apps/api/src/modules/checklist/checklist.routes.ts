import { Hono } from 'hono';
import {
  applicantIdParamSchema,
  checklistItemIdParamSchema,
  checklistQuerySchema,
  patchChecklistItemSchema,
} from '@visaitaly/shared';
import { requireSession } from '../../middleware/auth.js';
import { parseOrThrow, jsonBody } from '../../lib/validate.js';
import {
  acknowledgeReview,
  getChecklistItem,
  getJourney,
  listChecklist,
  setChecklistStatus,
} from './checklist.service.js';
import type { AppEnv } from '../../env.js';

const localeOf = (raw: string | undefined) => (raw && /^[a-z]{2}$/.test(raw) ? raw : 'en');

/** Mounted at /v1/applicants — per-applicant case views. */
export const applicantCaseRoutes = new Hono<AppEnv>();
applicantCaseRoutes.use('*', requireSession);

/** GET /v1/applicants/:id/checklist — Screen 10. */
applicantCaseRoutes.get('/:id/checklist', async (c) => {
  const { userId } = c.get('session');
  const { id } = parseOrThrow(applicantIdParamSchema, { id: c.req.param('id') });
  const q = parseOrThrow(checklistQuerySchema, c.req.query());
  return c.json(await listChecklist(c.get('db'), userId, id, localeOf(c.req.query('locale')), q));
});

/** GET /v1/applicants/:id/journey — Screen 12. */
applicantCaseRoutes.get('/:id/journey', async (c) => {
  const { userId } = c.get('session');
  const { id } = parseOrThrow(applicantIdParamSchema, { id: c.req.param('id') });
  return c.json(await getJourney(c.get('db'), userId, id));
});

/** Mounted at /v1/checklist — single items. */
export const checklistRoutes = new Hono<AppEnv>();
checklistRoutes.use('*', requireSession);

const idOf = (raw: string | undefined) =>
  parseOrThrow(checklistItemIdParamSchema, { id: raw }).id;

/** GET /v1/checklist/:id — Screen 11. */
checklistRoutes.get('/:id', async (c) => {
  const { userId } = c.get('session');
  return c.json(
    await getChecklistItem(c.get('db'), userId, idOf(c.req.param('id')), localeOf(c.req.query('locale'))),
  );
});

/** PATCH /v1/checklist/:id — status change, offline-safe. */
checklistRoutes.patch('/:id', async (c) => {
  const { userId } = c.get('session');
  const input = parseOrThrow(patchChecklistItemSchema, await jsonBody(c.req.raw));
  return c.json(
    await setChecklistStatus(
      c.get('db'),
      userId,
      idOf(c.req.param('id')),
      input,
      localeOf(c.req.query('locale')),
    ),
  );
});

/** POST /v1/checklist/:id/acknowledge-review — clears the Needs Review badge. */
checklistRoutes.post('/:id/acknowledge-review', async (c) => {
  const { userId } = c.get('session');
  return c.json(
    await acknowledgeReview(c.get('db'), userId, idOf(c.req.param('id')), localeOf(c.req.query('locale'))),
  );
});
