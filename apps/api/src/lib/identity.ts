import type { Env } from '../env.js';
import {
  createTokenProvider,
  type FetchLike,
  type ServiceAccount,
} from './fcm.js';

/**
 * Removes the person's login at Firebase Authentication — the last step of erasure (DATA-PRIVACY §4).
 * Runs from the Cron only. 'not_found' counts as success: the identity is already gone.
 */
export type IdentityDeleteResult = 'deleted' | 'not_found' | 'retry';

export interface IdentityDeleter {
  deleteUser(firebaseUid: string): Promise<IdentityDeleteResult>;
}

const SCOPE = 'https://www.googleapis.com/auth/identitytoolkit';

/**
 * Identity Toolkit `accounts:delete` with the project's service account (the same secret the push
 * sender uses; the account needs the "Firebase Authentication Admin" role).
 *
 * NOT exercised against real Firebase in CI — request shape follows the documented REST contract and is
 * unit-tested with a fake fetch. The end-to-end erasure test on staging is the verification
 * (docs/DATA-PRIVACY.md "Test").
 */
export function createIdentityDeleter(
  serviceAccountJson: string,
  doFetch: FetchLike = (u, i) => fetch(u, i),
  now: () => number = Date.now,
): IdentityDeleter {
  const sa = JSON.parse(serviceAccountJson) as ServiceAccount;
  const token = createTokenProvider(sa, SCOPE, doFetch, now);

  const call = async (bearer: string, uid: string) =>
    doFetch(`https://identitytoolkit.googleapis.com/v1/projects/${sa.project_id}/accounts:delete`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ localId: uid }),
    });

  return {
    async deleteUser(uid) {
      try {
        let res = await call(await token(), uid);
        if (res.status === 401) res = await call(await token(true), uid);
        if (res.ok) return 'deleted';
        const err = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        if (res.status === 404 || err?.error?.message?.includes('USER_NOT_FOUND')) return 'not_found';
        return 'retry';
      } catch {
        return 'retry';
      }
    },
  };
}

export function identityDeleterFor(env: Env): IdentityDeleter | undefined {
  return env.FCM_SERVICE_ACCOUNT ? createIdentityDeleter(env.FCM_SERVICE_ACCOUNT) : undefined;
}
