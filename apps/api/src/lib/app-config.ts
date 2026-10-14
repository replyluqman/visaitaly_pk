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
 * They MUST match the values seeded in migrations 0001/0002/0005. A fallback that silently
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

/** app_config['checklist'] */
export interface ChecklistConfigValue {
  /** PRD §8: free users see this many applicable items; the rest are locked. */
  free_preview_items: number;
}

/** app_config['uploads'] */
export interface UploadsConfigValue {
  max_file_bytes: number;
  max_bytes_per_user: number;
  upload_url_ttl_seconds: number;
  view_url_ttl_seconds: number;
  /** Soft-deleted document rows are purged after this many days. */
  deleted_retention_days: number;
  allowed_mimes: string[];
}

/** app_config['today'] */
export interface TodayConfigValue {
  max_actions: number;
  expiry_window_days: number;
  /** Applicants refreshed per Cron run, stalest first. */
  batch_size: number;
  /** An applicant's next_actions row is not recomputed more often than this. */
  min_age_minutes: number;
}

export const UPLOADS_CONFIG_FALLBACK: UploadsConfigValue = {
  max_file_bytes: 10_485_760,
  max_bytes_per_user: 524_288_000,
  upload_url_ttl_seconds: 900,
  view_url_ttl_seconds: 300,
  deleted_retention_days: 30,
  allowed_mimes: ['image/jpeg', 'image/png', 'application/pdf'],
};
export const TODAY_CONFIG_FALLBACK: TodayConfigValue = {
  max_actions: 5,
  expiry_window_days: 30,
  batch_size: 15000,
  min_age_minutes: 30,
};

/** app_config['verification'] */
export interface VerificationConfigValue {
  /** Sources checked per daily sweep (Workers free tier allows 50 subrequests per invocation). */
  hash_sweep_batch: number;
  fetch_timeout_ms: number;
  max_body_bytes: number;
  /** Consecutive failed checks before the admin home flags a source as unreachable. */
  failure_alert_after: number;
  /** A source is re-checked once it has gone this long without a check (the sweep runs every tick). */
  recheck_after_hours: number;
}

export const VERIFICATION_CONFIG_FALLBACK: VerificationConfigValue = {
  hash_sweep_batch: 20,
  fetch_timeout_ms: 10_000,
  max_body_bytes: 2_000_000,
  failure_alert_after: 3,
  recheck_after_hours: 20,
};

/** app_config['notifications'] */
export interface NotificationsConfigValue {
  /** FCM sends per Cron run. Workers free tier allows 50 subrequests per invocation. */
  push_max_per_run: number;
  push_max_attempts: number;
  retention_days_read: number;
  retention_batch: number;
}

/** app_config['reminders'] */
export interface RemindersConfigValue {
  /** Thresholds in days before expiry; one reminder per threshold crossed. */
  days_before: number[];
  batch_size: number;
}

export const NOTIFICATIONS_CONFIG_FALLBACK: NotificationsConfigValue = {
  push_max_per_run: 40,
  push_max_attempts: 3,
  retention_days_read: 90,
  retention_batch: 5000,
};
export const REMINDERS_CONFIG_FALLBACK: RemindersConfigValue = { days_before: [30, 7, 1], batch_size: 5000 };

/** app_config['privacy'] */
export interface PrivacyConfigValue {
  /** Account deletion needs a Firebase sign-in at most this old. */
  reauth_window_seconds: number;
  export_retention_days: number;
  export_cooldown_hours: number;
  export_download_ttl_seconds: number;
  /** R2 objects removed per Cron run during erasure (subrequest budget). */
  delete_objects_per_run: number;
  max_attempts: number;
  /** Rows per collection included in an export before it is marked truncated. */
  export_row_cap: number;
}

export const PRIVACY_CONFIG_FALLBACK: PrivacyConfigValue = {
  reauth_window_seconds: 300,
  export_retention_days: 7,
  export_cooldown_hours: 24,
  export_download_ttl_seconds: 600,
  delete_objects_per_run: 40,
  max_attempts: 10,
  export_row_cap: 5000,
};

/** app_config['support'] */
export interface SupportConfigValue {
  /** Topics a FREE account may use; paid accounts may use all (PRD §8, §10). */
  topics_free: string[];
  messages_per_hour: number;
  attachment_max_bytes: number;
  attachment_upload_ttl_seconds: number;
  retention_months: number;
}

/** app_config['sla'] (PRD §14a). `working_hours_text` is COPY — authored in the CMS, no default. */
export interface SlaConfigValue {
  support_paid_hours: number;
  support_free_hours: number;
  working_hours_windows: {
    utc_offset_minutes: number;
    days: number[];
    start_minute: number;
    end_minute: number;
  };
  working_hours_text?: Record<string, string>;
}

export const SUPPORT_CONFIG_FALLBACK: SupportConfigValue = {
  topics_free: ['presales', 'app_problem', 'account'],
  messages_per_hour: 20,
  attachment_max_bytes: 5_242_880,
  attachment_upload_ttl_seconds: 900,
  retention_months: 24,
};
export const SLA_CONFIG_FALLBACK: SlaConfigValue = {
  support_paid_hours: 24,
  support_free_hours: 48,
  working_hours_windows: { utc_offset_minutes: 300, days: [1, 2, 3, 4, 5, 6], start_minute: 540, end_minute: 1080 },
  // Declared so readConfig (which only copies keys the fallback knows) keeps the CMS-authored copy; undefined = not set yet.
  working_hours_text: undefined,
};

export const AUTH_CONFIG_FALLBACK: AuthConfigValue = { max_active_devices: 2 };
export const ONBOARDING_CONFIG_FALLBACK: OnboardingConfigValue = { max_applicants: 10 };
export const CHECKLIST_CONFIG_FALLBACK: ChecklistConfigValue = { free_preview_items: 3 };
export const NULLA_OSTA_CONFIG_FALLBACK: NullaOstaConfigValue = {
  validity_months: 6,
  expiry_warning_days: 30,
};

/** Compile-time map so readConfig('nulla_osta', …) can only be paired with the right shape. */
export interface AppConfigMap {
  auth: AuthConfigValue;
  onboarding: OnboardingConfigValue;
  nulla_osta: NullaOstaConfigValue;
  checklist: ChecklistConfigValue;
  uploads: UploadsConfigValue;
  today: TodayConfigValue;
  verification: VerificationConfigValue;
  notifications: NotificationsConfigValue;
  reminders: RemindersConfigValue;
  privacy: PrivacyConfigValue;
  support: SupportConfigValue;
  sla: SlaConfigValue;
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
