import { Auth, WorkersKVStoreSingle, type KeyStorer } from 'firebase-auth-cloudflare-workers';
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

/**
 * With FIREBASE_AUTH_EMULATOR_HOST set, the library accepts UNSIGNED tokens, so
 * anyone could mint a token for any user. The variable is honoured only when
 * ENVIRONMENT is exactly 'development'; everywhere else it is stripped before the
 * env reaches the library, even if someone sets it as a var or secret by mistake.
 * `pnpm preflight` also fails a deploy whose config declares it.
 */
export function libraryEnv(env: Env): Env {
  if (env.ENVIRONMENT === 'development') return env;
  return { ...env, FIREBASE_AUTH_EMULATOR_HOST: undefined };
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
    const token = await auth.verifyIdToken(jwt, false, libraryEnv(env));
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

// ---------------------------------------------------------------------------
// admin tokens — a SEPARATE Firebase project (ADR 0012)
// ---------------------------------------------------------------------------

export interface VerifiedAdminToken {
  uid: string;
  email: string | null;
  emailVerified: boolean;
  /** The token carries `firebase.sign_in_second_factor` (the admin completed MFA). */
  mfa: boolean;
}

/**
 * `Auth.getOrInitialize` is a process-wide singleton that IGNORES the project id after the
 * first call, so using it for a second project would silently verify admin tokens against the
 * user project (or the reverse). The admin verifier therefore builds its own BaseAuth, cached
 * per project id.
 */
const adminAuthByProject = new Map<string, Auth>();

/**
 * The library marks `Auth`'s constructor private precisely to force the singleton; the cast below
 * is the one deliberate escape from that. `test/admin-token.test.ts` verifies against REAL tokens
 * that a token for the user project is rejected here and vice versa — if a library upgrade ever
 * changes the constructor, that test fails.
 */
const AuthCtor = Auth as unknown as new (projectId: string, keyStore: KeyStorer) => Auth;

export function adminAuthFor(projectId: string, keyStore: KeyStorer): Auth {
  let auth = adminAuthByProject.get(projectId);
  if (!auth) {
    auth = new AuthCtor(projectId, keyStore);
    adminAuthByProject.set(projectId, auth);
  }
  return auth;
}

function adminAuth(env: Env): Auth {
  return adminAuthFor(
    env.ADMIN_FIREBASE_PROJECT_ID,
    // Separate cache key: the admin project's JWKs must not overwrite the user project's.
    WorkersKVStoreSingle.getOrInitialize(`${env.PUBLIC_JWK_CACHE_KEY}:admin`, env.PUBLIC_JWK_CACHE_KV),
  );
}

export async function verifyAdminIdToken(
  authorizationHeader: string | undefined,
  env: Env,
): Promise<VerifiedAdminToken> {
  if (!authorizationHeader) throw AppError.unauthenticated('Missing Authorization header.');
  const jwt = authorizationHeader.replace(/^Bearer\s+/i, '').trim();
  if (!jwt) throw AppError.unauthenticated('Malformed Authorization header.');

  try {
    const token = await adminAuth(env).verifyIdToken(jwt, false, libraryEnv(env));
    return {
      uid: token.uid,
      email: typeof token.email === 'string' ? token.email.toLowerCase() : null,
      emailVerified: token.email_verified === true,
      mfa: typeof token.firebase?.sign_in_second_factor === 'string',
    };
  } catch {
    throw AppError.unauthenticated('Session expired. Please sign in again.');
  }
}
