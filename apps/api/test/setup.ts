import { vi } from 'vitest';
import { AppError } from '../src/lib/errors.js';

/**
 * Firebase is the one external dependency we replace. Test tokens look like
 * `Bearer test:<uid>[:<email>]`; anything else is rejected exactly as the real
 * verifier rejects a bad token. Everything below the token — middleware, SQL,
 * services — is the production code path.
 */
vi.mock('../src/lib/firebase.js', async (orig) => {
  const actual = await orig<typeof import('../src/lib/firebase.js')>();
  return {
    ...actual,
    verifyFirebaseIdToken: async (header: string | undefined) => {
      if (!header) throw AppError.unauthenticated('Missing Authorization header.');
      const jwt = header.replace(/^Bearer\s+/i, '').trim();
      const [prefix, uid, email, name] = jwt.split(':');
      if (prefix !== 'test' || !uid) {
        throw AppError.unauthenticated('Session expired. Please sign in again.');
      }
      return {
        uid,
        email: email ? email.toLowerCase() : null,
        displayName: name ?? null,
        emailVerified: true,
      };
    },
  };
});
