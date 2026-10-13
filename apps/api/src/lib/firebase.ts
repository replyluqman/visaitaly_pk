import { Auth, WorkersKVStoreSingle } from 'firebase-auth-cloudflare-workers';
import type { Env } from '../env.js';
import { AppError } from './errors.js';

/**
 * Single place that touches firebase-auth-cloudflare-workers.
 *
 * RESOLVED against v2.0.6: the signature is
 *   verifyIdToken(idToken, checkRevoked?, env?, clockSkewSeconds?)
 * so `env` MUST be the third argument. Passing it second silently binds it to
 * `checkRevoked` — an object is truthy, which turns on Firebase refresh-token
 * revocation checking on every request. We deliberately do not use that:
 * eviction is app-level via devices.status (see the devices table comment), and
 * revocation checking costs an extra admin API call per request against the
 * 10ms CPU budget.
 */
export interface VerifiedToken {
  uid: string;
  email: string | null;
  displayName: string | null;
  emailVerified: boolean;
}

export async function verifyFirebaseIdToken(
  authorizationHeader: string | undefined,
  env: Env,
): Promise<VerifiedToken> {
  if (!authorizationHeader) throw AppError.unauthenticated('Missing Authorization header.');

  const jwt = authorizationHeader.replace(/^Bearer\s+/i, '').trim();
  if (!jwt) throw AppError.unauthenticated('Malformed Authorization header.');

  const auth = Auth.getOrInitialize(
    env.FIREBASE_PROJECT_ID,
    WorkersKVStoreSingle.getOrInitialize(env.PUBLIC_JWK_CACHE_KEY, env.PUBLIC_JWK_CACHE_KV),
  );

  try {
    const token = await auth.verifyIdToken(jwt, false, env);
    return {
      uid: token.uid,
      email: typeof token.email === 'string' ? token.email.toLowerCase() : null,
      displayName: typeof token.name === 'string' ? token.name : null,
      emailVerified: token.email_verified === true,
    };
  } catch {
    // Expired, wrong project, bad signature — all the same to the client:
    // re-authenticate. Never echo the underlying reason.
    throw AppError.unauthenticated('Session expired. Please sign in again.');
  }
}
