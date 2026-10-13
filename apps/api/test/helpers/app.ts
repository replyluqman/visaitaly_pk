import { randomUUID } from 'node:crypto';
import app from '../../src/index.js';
import type { Env } from '../../src/env.js';
import { testDatabaseUrl } from './config.js';

const env: Env = {
  HYPERDRIVE: { connectionString: testDatabaseUrl() },
  FIREBASE_PROJECT_ID: 'test',
  PUBLIC_JWK_CACHE_KV: {} as KVNamespace,
  PUBLIC_JWK_CACHE_KEY: 'test',
  ENVIRONMENT: 'development',
  FIREBASE_AUTH_EMULATOR_HOST: undefined,
};

export interface CallOpts {
  uid?: string;
  email?: string;
  deviceId?: string;
  body?: unknown;
  rawBody?: string;
  headers?: Record<string, string>;
}

export interface Res<T = any> {
  status: number;
  body: T;
}

/** Drives the real Hono app in-process: real middleware, real SQL. */
export async function call<T = any>(method: string, path: string, o: CallOpts = {}): Promise<Res<T>> {
  const headers: Record<string, string> = { ...(o.headers ?? {}) };
  if (o.uid) headers.Authorization = `Bearer test:${o.uid}${o.email ? `:${o.email}` : ''}`;
  if (o.deviceId) headers['X-Device-Id'] = o.deviceId;
  let body: string | undefined;
  if (o.rawBody !== undefined) body = o.rawBody;
  else if (o.body !== undefined) body = JSON.stringify(o.body);
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => void pending.push(p),
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;

  const res = await app.fetch(new Request(`http://t${path}`, { method, headers, body }), env, ctx);
  await Promise.all(pending);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

export interface TestUser {
  uid: string;
  email: string;
  deviceId: string;
}

export const newUser = (n = randomUUID().slice(0, 8)): TestUser => ({
  uid: `u_${n}`,
  email: `${n}@example.com`,
  deviceId: randomUUID(),
});

export const login = (u: TestUser, extra: Record<string, unknown> = {}) =>
  call('POST', '/v1/auth/session', {
    uid: u.uid,
    email: u.email,
    body: { deviceId: u.deviceId, platform: 'android', appVersion: '1.0.0', ...extra },
  });

/** Authenticated request as a logged-in user. */
export const as = (u: TestUser) => (method: string, path: string, body?: unknown) =>
  call(method, path, { uid: u.uid, deviceId: u.deviceId, body });

/** Same as call() but returns the raw Response (for header assertions). */
export async function rawFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
  return app.fetch(new Request(`http://t${path}`, init), env, ctx);
}
