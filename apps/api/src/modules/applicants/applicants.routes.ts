import { Hono } from 'hono';
import {
  applicantIdParamSchema,
  createApplicantSchema,
  patchApplicantSchema,
  setStageSchema,
} from '@visaitaly/shared';
import { requireSession } from '../../middleware/auth.js';
import { parseOrThrow, jsonBody } from '../../lib/validate.js';
import {
  createApplicant,
  deleteApplicant,
  getApplicant,
  listApplicants,
  setApplicantStage,
  updateApplicant,
} from './applicants.service.js';
import type { AppEnv } from '../../env.js';

export const applicantRoutes = new Hono<AppEnv>();

applicantRoutes.use('*', requireSession);

/** Locale only selects display labels; Urdu content is gated by PRD §11a. */
const localeOf = (raw: string | undefined) => (raw && /^[a-z]{2}$/.test(raw) ? raw : 'en');
const idOf = (raw: string | undefined) => parseOrThrow(applicantIdParamSchema, { id: raw }).id;

/** GET /v1/applicants — Screens §8 Family Dashboard source. */
applicantRoutes.get('/', async (c) => {
  const { userId } = c.get('session');
  return c.json(await listApplicants(c.get('db'), userId, localeOf(c.req.query('locale'))));
});

/** POST /v1/applicants — Screens §6. */
applicantRoutes.post('/', async (c) => {
  const { userId } = c.get('session');
  const input = parseOrThrow(createApplicantSchema, await jsonBody(c.req.raw));
  const result = await createApplicant(
    c.get('db'),
    userId,
    input,
    localeOf(c.req.query('locale')),
  );
  return c.json(result, 201);
});

/** GET /v1/applicants/:id — Screens §10 Applicant Case View header. */
applicantRoutes.get('/:id', async (c) => {
  const { userId } = c.get('session');
  return c.json(
    await getApplicant(c.get('db'), userId, idOf(c.req.param('id')), localeOf(c.req.query('locale'))),
  );
});

/** PATCH /v1/applicants/:id — profile corrections. Stage has its own route. */
applicantRoutes.patch('/:id', async (c) => {
  const { userId } = c.get('session');
  const input = parseOrThrow(patchApplicantSchema, await jsonBody(c.req.raw));
  return c.json(
    await updateApplicant(
      c.get('db'),
      userId,
      idOf(c.req.param('id')),
      input,
      localeOf(c.req.query('locale')),
    ),
  );
});

/** PATCH /v1/applicants/:id/stage — Screens §7. Seeds the journey engine. */
applicantRoutes.patch('/:id/stage', async (c) => {
  const { userId } = c.get('session');
  const { currentStage } = parseOrThrow(setStageSchema, await jsonBody(c.req.raw));
  return c.json(
    await setApplicantStage(
      c.get('db'),
      userId,
      idOf(c.req.param('id')),
      currentStage,
      localeOf(c.req.query('locale')),
    ),
  );
});

/** DELETE /v1/applicants/:id — soft delete. */
applicantRoutes.delete('/:id', async (c) => {
  const { userId } = c.get('session');
  return c.json(await deleteApplicant(c.get('db'), userId, idOf(c.req.param('id'))));
});
