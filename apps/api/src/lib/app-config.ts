import { sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';

/**
 * PRD §6 — zero hardcoding. Every tunable lives in app_config and is read
 * through here with a named fallback, so a missing or malformed CMS row
 * degrades to a documented default instead of a 500.
 *
 * The fallbacks are NOT the source of truth. They exist so a fresh database
 * boots and so a bad CMS write cannot take the API down. If a fallback is ever
 * observed in production, that is an alert, not a shrug.
 *
 * They MUST match the values seeded in migration 0002. A fallback that silently
 * disagrees with the database is worse than no fallback: behaviour then depends
 * on whether a row happened to load.
 */

// ---------------------------------------------------------------------------
// value shapes — one per app_config key
// ---------------------------------------------------------------------------

/** app_config['auth'] */
export interface AuthConfigValue {
  max_active_devices: number;
}

/** app_config['onboarding'] */
export interface OnboardingConfigValue {
  max_applicants: number;
}

/** app_config['nulla_osta'] */
export interface NullaOstaConfigValue {
  /** Months from issue date to expiry. Derived here until the CMS module owns it. */
  validity_months: number;
  /** Days before expiry that the tracker starts warning. Not consumed yet — the
   *  reminder job is a later module — but it is already seeded, and readConfig
   *  drops any key absent from the fallback, so it must be declared here. */
  expiry_warning_days: number;
}

export const AUTH_CONFIG_FALLBACK: AuthConfigValue = { max_active_devices: 2 };
export const ONBOARDING_CONFIG_FALLBACK: OnboardingConfigValue = { max_applicants: 10 };
export const NULLA_OSTA_CONFIG_FALLBACK: NullaOstaConfigValue = {
  validity_months: 6,
  expiry_warning_days: 30,
};

/** Compile-time map so readConfig('nulla_osta', …) can only be paired with the right shape. */
export interface AppConfigMap {
  auth: AuthConfigValue;
  onboarding: OnboardingConfigValue;
  nulla_osta: NullaOstaConfigValue;
}

export type AppConfigKey = keyof AppConfigMap;

/**
 * Read one config key. Missing row, null value, or a value missing keys all
 * fall back field-by-field — a partial CMS row still yields a complete object.
 *
 * One indexed primary-key lookup. Callers that need config inside a transaction
 * pass the transaction handle so the read sees the same snapshot as the write.
 */
export async function readConfig<K extends AppConfigKey>(
  db: Db,
  key: K,
  fallback: AppConfigMap[K],
): Promise<AppConfigMap[K]> {
  const result = await db.execute<{ value: unknown }>(sql`
    SELECT value FROM app_config WHERE key = ${key}
  `);

  const value = result.rows[0]?.value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fallback;

  const merged = { ...fallback } as Record<string, unknown>;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v !== null && v !== undefined && k in merged) merged[k] = v;
  }
  // Safe by construction: `merged` starts as a full copy of `fallback` and only
  // ever has existing keys overwritten, so every required field is present.
  return merged as unknown as AppConfigMap[K];
}
