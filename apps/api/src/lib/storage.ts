import type { Env } from '../env.js';

/** What the API needs from object storage. R2 in production, an in-memory map in tests. */
export interface ObjectStore {
  put(key: string, body: ReadableStream | ArrayBuffer | Uint8Array, contentType: string): Promise<void>;
  /** Size in bytes, or null if the object does not exist. */
  head(key: string): Promise<{ size: number } | null>;
  /** First `bytes` bytes (for magic-number verification), or null if absent. */
  readHead(key: string, bytes: number): Promise<Uint8Array | null>;
  get(key: string): Promise<{ body: ReadableStream; size: number } | null>;
  /** Idempotent: deleting a missing object is not an error. */
  delete(key: string): Promise<void>;
}

/**
 * Production store. The bucket has no public access and no S3 credentials are issued, so
 * the only way to an object is this binding — which only the Worker holds — after the
 * Worker has checked ownership (session) or a valid short-lived signature (docs/SECURITY.md).
 */
export function createR2Store(env: Env): ObjectStore {
  const bucket = env.DOCS_BUCKET;
  return {
    async put(key, body, contentType) {
      await bucket.put(key, body, { httpMetadata: { contentType } });
    },
    async head(key) {
      const o = await bucket.head(key);
      return o ? { size: o.size } : null;
    },
    async readHead(key, bytes) {
      const o = await bucket.get(key, { range: { offset: 0, length: bytes } });
      return o ? new Uint8Array(await o.arrayBuffer()) : null;
    },
    async get(key) {
      const o = await bucket.get(key);
      return o ? { body: o.body, size: o.size } : null;
    },
    async delete(key) {
      await bucket.delete(key);
    },
  };
}
