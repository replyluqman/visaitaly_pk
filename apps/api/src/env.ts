import type { Db } from './db/client.js';
import type { VerifiedToken } from './lib/firebase.js';

/**
 * Worker bindings. Every one of these is declared in wrangler.toml.
 * Secrets are set with `wrangler secret put`, never committed.
 */
export interface Env {
  /** Hyperdrive binding — pooled Neon connection (PRD §4, mandatory). */
  HYPERDRIVE: { connectionString: string };

  /** Firebase project that issues the ID tokens we verify. Not a secret. */
  FIREBASE_PROJECT_ID: string;

  /** KV namespace caching Google's public JWKs so we don't refetch per request. */
  PUBLIC_JWK_CACHE_KV: KVNamespace;
  /** Cache key inside PUBLIC_JWK_CACHE_KV. */
  PUBLIC_JWK_CACHE_KEY: string;

  /** 'development' | 'staging' | 'production'. Controls error verbosity only. */
  ENVIRONMENT: string;

  /**
   * Required by the library's EmulatorEnv, not optional in its type. Left
   * undefined in every real environment — set it only to point local dev at the
   * Firebase Auth emulator. If it is ever set in production, tokens are
   * accepted UNSIGNED.
   */
  FIREBASE_AUTH_EMULATOR_HOST: string | undefined;
}

/** Resolved caller identity, set by requireSession. */
export interface Session {
  /** users.id — the internal uuid, never the Firebase uid. */
  userId: string;
  /** devices.device_id — client-generated UUIDv4 from the X-Device-Id header. */
  deviceId: string;
}

/**
 * Hono generic. `db` is set per request by the db middleware; `auth` by
 * requireAuth; `session` by requireSession.
 *
 * `auth` and `session` are typed non-optional because the middleware that reads
 * them is the same middleware that sets them — a handler that reads `session`
 * without requireSession mounted is a wiring bug, not a runtime branch.
 */
export interface AppEnv {
  Bindings: Env;
  Variables: {
    db: Db;
    auth: VerifiedToken;
    session: Session;
    requestId: string;
  };
}
