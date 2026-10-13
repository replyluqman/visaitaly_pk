import { randomUUID } from 'node:crypto';
import { createApp } from '../../src/index.js';
import type { Env } from '../../src/env.js';
import type { ObjectStore } from '../../src/lib/storage.js';
import { testDatabaseUrl } from './config.js';

/** In-memory R2 stand-in: the same ObjectStore contract the production adapter implements. */
export class FakeStore implements ObjectStore {
  objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
  failDeletes = false;

  async put(key: string, body: ReadableStream | ArrayBuffer | Uint8Array, contentType: string) {
    const bytes =
      body instanceof Uint8Array ? body : new Uint8Array(await new Response(body as BodyInit).arrayBuffer());
    this.objects.set(key, { bytes, contentType });
  }
  async head(key: string) {
    const o = this.objects.get(key);
    return o ? { size: o.bytes.length } : null;
  }
  async readHead(key: string, n: number) {
    return this.objects.get(key)?.bytes.slice(0, n) ?? null;
  }
  async get(key: string) {
    const o = this.objects.get(key);
    if (!o) return null;
    const bytes = o.bytes;
    return { body: new Response(bytes).body!, size: bytes.length };
  }
  async delete(key: string) {
    if (this.failDeletes) throw new Error('r2 unavailable');
    this.objects.delete(key);
  }
}

export const store = new FakeStore();
const app = createApp({ createStore: () => store });

export const SIGNING_KEY = 'test-signing-key-0123456789abcdef0123456789abcdef';

export const env: Env = {
  DOCS_BUCKET: {} as R2Bucket,
  DOCUMENTS_SIGNING_KEY: SIGNING_KEY,
  HYPERDRIVE: { connectionString: testDatabaseUrl() },
  FIREBASE_PROJECT_ID: 'test',
  PUBLIC_JWK_CACHE_KV: {} as KVNamespace,
  PUBLIC_JWK_CACHE_KEY: 'test',
  ENVIRONMENT: 'development',
  FIREBASE_AUTH_EMULATOR_HOST: undefined,
};

export interface CallOpts {
  bytes?: Uint8Array;
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
  bytes: Uint8Array;
  headers: Headers;
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

  const res = await app.fetch(
    new Request(`http://t${path}`, { method, headers, body: o.bytes ?? body }),
    env,
    ctx,
  );
  await Promise.all(pending);
  const buf = new Uint8Array(await res.arrayBuffer());
  const isJson = (res.headers.get('content-type') ?? '').includes('json');
  return {
    status: res.status,
    body: isJson && buf.length ? JSON.parse(new TextDecoder().decode(buf)) : null,
    bytes: buf,
    headers: res.headers,
  };
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
