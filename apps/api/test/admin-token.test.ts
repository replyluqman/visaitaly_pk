import { describe, expect, it } from 'vitest';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { Auth, type KeyStorer } from 'firebase-auth-cloudflare-workers';
import { adminAuthFor } from '../src/lib/firebase.js';

/**
 * The security core of ADR 0012, proven with REAL signed JWTs and the real verifier (not the
 * test mock used elsewhere): a token minted for the user Firebase project must never verify
 * as an admin token, and vice versa — and the library's singleton quirk must not leak one
 * project's verifier into the other.
 */
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS256', use: 'sig' };
const keys: KeyStorer = {
  get: async <T>() => [jwk] as unknown as T,
  put: async () => {},
};

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
function mint(project: string, extra: Record<string, unknown> = {}, secondFactor = false): string {
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'RS256', kid: 'test-key', typ: 'JWT' });
  const body = b64({
    iss: `https://securetoken.google.com/${project}`,
    aud: project,
    sub: 'uid-1',
    auth_time: now - 10,
    iat: now - 10,
    exp: now + 3600,
    email: 'someone@example.com',
    email_verified: true,
    firebase: { sign_in_provider: 'password', ...(secondFactor ? { sign_in_second_factor: 'phone' } : {}) },
    ...extra,
  });
  const sig = createSign('RSA-SHA256').update(`${head}.${body}`).sign(privateKey).toString('base64url');
  return `${head}.${body}.${sig}`;
}

describe('admin vs user Firebase project separation (ADR 0012)', () => {
  const userAuth = Auth.getOrInitialize('proj-user', keys);
  const adminAuth = adminAuthFor('proj-admin', keys);

  it('a token for the user project verifies as a user token but NOT as an admin token', async () => {
    const token = mint('proj-user');
    expect((await userAuth.verifyIdToken(token, false)).uid).toBe('uid-1');
    await expect(adminAuth.verifyIdToken(token, false)).rejects.toThrow();
  });

  it('a token for the admin project verifies as admin but NOT as a user token', async () => {
    const token = mint('proj-admin');
    expect((await adminAuth.verifyIdToken(token, false)).uid).toBe('uid-1');
    await expect(userAuth.verifyIdToken(token, false)).rejects.toThrow();
  });

  it('the singleton quirk is real: Auth.getOrInitialize ignores a second project id', () => {
    expect(Auth.getOrInitialize('proj-admin', keys)).toBe(userAuth);
    expect(adminAuthFor('proj-admin', keys)).not.toBe(userAuth);
    expect(adminAuthFor('proj-admin', keys)).toBe(adminAuth); // cached per project
  });

  it('the second-factor claim is visible to the middleware only when present', async () => {
    const plain = await adminAuth.verifyIdToken(mint('proj-admin'), false);
    const mfa = await adminAuth.verifyIdToken(mint('proj-admin', {}, true), false);
    expect(plain.firebase.sign_in_second_factor).toBeUndefined();
    expect(mfa.firebase.sign_in_second_factor).toBe('phone');
  });

  it('expired and forged tokens are rejected', async () => {
    const expired = mint('proj-admin', { exp: Math.floor(Date.now() / 1000) - 60, iat: Math.floor(Date.now() / 1000) - 7200 });
    await expect(adminAuth.verifyIdToken(expired, false)).rejects.toThrow();
    const [h, p] = mint('proj-admin').split('.');
    await expect(adminAuth.verifyIdToken(`${h}.${p}.${'A'.repeat(342)}`, false)).rejects.toThrow();
  });
});
