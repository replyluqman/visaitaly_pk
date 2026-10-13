import type { Env } from '../env.js';

/**
 * Push delivery (PRD §14: FCM is a delivery channel only — a missed push loses nothing, the inbox is
 * the record). Used by the Cron, never on a request path.
 */
export type PushResult = 'ok' | 'invalid_token' | 'retry';

export interface PushMessage {
  title: string;
  body: string;
  /** FCM data payload: all values must be strings. */
  data: Record<string, string>;
}

export interface PushSender {
  send(token: string, msg: PushMessage): Promise<PushResult>;
}

type ServiceAccount = { client_email: string; private_key: string; project_id: string };
type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

const enc = new TextEncoder();
const b64url = (b: ArrayBuffer | Uint8Array | string): string => {
  const bytes = typeof b === 'string' ? enc.encode(b) : new Uint8Array(b);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

async function importPkcs8(pem: string): Promise<CryptoKey> {
  const der = Uint8Array.from(
    atob(pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '').replace(/\s+/g, '')),
    (c) => c.charCodeAt(0),
  );
  return crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
}

/** OAuth2 service-account assertion (RS256), scope firebase.messaging. */
export const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

export async function signAssertion(
  sa: ServiceAccount, nowSeconds: number, scope: string = FCM_SCOPE,
): Promise<string> {
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(
    JSON.stringify({
      iss: sa.client_email,
      scope,
      aud: 'https://oauth2.googleapis.com/token',
      iat: nowSeconds,
      exp: nowSeconds + 3600,
    }),
  );
  const sig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5', await importPkcs8(sa.private_key), enc.encode(`${head}.${claims}`),
  );
  return `${head}.${claims}.${b64url(sig)}`;
}

export type TokenProvider = (force?: boolean) => Promise<string>;

/**
 * OAuth2 access tokens for a Google service account, cached for the isolate's life (valid for an hour,
 * refreshed a minute early). Shared by FCM and the Identity Toolkit deleter.
 */
export function createTokenProvider(
  sa: ServiceAccount, scope: string, doFetch: FetchLike = (u, i) => fetch(u, i), now: () => number = Date.now,
): TokenProvider {
  let cached: { token: string; expiresAt: number } | null = null;
  return async (force = false) => {
    if (!force && cached && cached.expiresAt > now() + 60_000) return cached.token;
    const assertion = await signAssertion(sa, Math.floor(now() / 1000), scope);
    const res = await doFetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
    });
    if (!res.ok) throw new Error(`google oauth ${res.status}`);
    const j = (await res.json()) as { access_token: string; expires_in: number };
    cached = { token: j.access_token, expiresAt: now() + j.expires_in * 1000 };
    return cached.token;
  };
}

export type { ServiceAccount, FetchLike };

/**
 * FCM HTTP v1 sender. Returns a result per token instead of throwing, so one bad device cannot stop the
 * batch.
 *
 * NOT exercised against the real FCM in CI — the request/response shapes follow Google's documented
 * HTTP v1 contract and are unit-tested with a fake fetch. The first staging send is the verification.
 */
export function createFcmSender(
  serviceAccountJson: string,
  doFetch: FetchLike = (u, i) => fetch(u, i),
  now: () => number = Date.now,
): PushSender {
  const sa = JSON.parse(serviceAccountJson) as ServiceAccount;
  const accessToken = createTokenProvider(sa, FCM_SCOPE, doFetch, now);

  async function post(token: string, msg: PushMessage, bearer: string): Promise<Response> {
    return doFetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: { token, notification: { title: msg.title, body: msg.body }, data: msg.data, android: { priority: 'HIGH' } },
      }),
    });
  }

  return {
    async send(token, msg) {
      try {
        let res = await post(token, msg, await accessToken());
        if (res.status === 401) res = await post(token, msg, await accessToken(true)); // expired mid-batch
        if (res.ok) return 'ok';
        const err = (await res.json().catch(() => null)) as {
          error?: { status?: string; details?: Array<{ errorCode?: string }> };
        } | null;
        const code = err?.error?.details?.find((d) => d.errorCode)?.errorCode;
        // The device token is dead (app uninstalled / token rotated): stop sending to it.
        if (res.status === 404 || code === 'UNREGISTERED' || err?.error?.status === 'NOT_FOUND') return 'invalid_token';
        if (res.status === 400 && (code === 'INVALID_ARGUMENT' || err?.error?.status === 'INVALID_ARGUMENT')) return 'invalid_token';
        return 'retry';
      } catch {
        return 'retry';
      }
    },
  };
}

/** Undefined when the secret is not configured — the Cron then skips push and logs it. */
export function pushSenderFor(env: Env): PushSender | undefined {
  return env.FCM_SERVICE_ACCOUNT ? createFcmSender(env.FCM_SERVICE_ACCOUNT) : undefined;
}
