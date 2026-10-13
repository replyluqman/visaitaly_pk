import { Hono } from 'hono';
import { applicantCountSchema } from '@visaitaly/shared';
import { requireSession } from '../../middleware/auth.js';
import { parseOrThrow, jsonBody } from '../../lib/validate.js';
import { setDeclaredApplicantCount } from './onboarding.service.js';
import type { AppEnv } from '../../env.js';

export const onboardingRoutes = new Hono<AppEnv>();

onboardingRoutes.use('*', requireSession);

/** PATCH /v1/onboarding/applicant-count — Screens §5. */
onboardingRoutes.patch('/applicant-count', async (c) => {
  const { userId } = c.get('session');
  const { declaredApplicantCount } = parseOrThrow(
    applicantCountSchema,
    await jsonBody(c.req.raw),
  );
  return c.json(await setDeclaredApplicantCount(c.get('db'), userId, declaredApplicantCount));
});
