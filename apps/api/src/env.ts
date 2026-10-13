import type { Db } from './db/client.js';
import type { VerifiedToken } from './lib/firebase.js';
import type { ObjectStore } from './lib/storage.js';

/**
 * Worker bindings. Every one of these is declared in wrangler.toml.
 * Secrets are set with `wrangler secret put`, never committed.
 */
export interface Env {
  /** Hyperdrive binding — pooled Neon connection (PRD §4, mandatory). */
  HYPERDRIVE: { connectionString: string };

  /** Firebase project that issues the ID tokens we verify. Not a secret. */
  FIREBASE_PROJECT_ID: string;

  /**
   * Firebase project that issues ADMIN tokens — deliberately NOT the user project (ADR 0012), so a
   * user token (audience = user project) can never authenticate an admin route.
   */
  ADMIN_FIREBASE_PROJECT_ID: string;

  /** 'true' in staging/production: admin tokens must carry a second factor. `pnpm preflight` enforces it. */
  ADMIN_REQUIRE_MFA: string;

  /** KV namespace caching Google's public JWKs so we don't refetch per request. */
  PUBLIC_JWK_CACHE_KV: KVNamespace;
  /** Cache key inside PUBLIC_JWK_CACHE_KV. */
  PUBLIC_JWK_CACHE_KEY: string;

  /**
   * Private R2 bucket for user documents. Never public, no S3 credentials issued: objects are
   * reachable only through this binding, i.e. through the Worker, behind a short-lived HMAC URL.
   */
  DOCS_BUCKET: R2Bucket;

  /** Secret. HMAC key (>= 32 random bytes) for document URLs. `wrangler secret put`. */
  DOCUMENTS_SIGNING_KEY: string;

  /**
   * Secret. Firebase service-account JSON (user project) used ONLY by the Cron to send FCM pushes
   * (HTTP v1). Absent → pushes are skipped and the inbox still works (Neon is the record, PRD §14).
   */
  FCM_SERVICE_ACCOUNT?: string;

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

/** Resolved admin identity, set by requireAdmin. */
export interface AdminContext {
  id: string;
  email: string;
  isSuper: boolean;
  scopes: ReadonlySet<string>;
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
    admin: AdminContext;
    store: ObjectStore;
    requestId: string;
  };
}
