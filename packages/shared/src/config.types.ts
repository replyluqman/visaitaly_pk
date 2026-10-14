import { z } from 'zod';

/**
 * Admin-editable app_config (Screen 43, scope pricing_config). One STRICT schema per key:
 * unknown fields are rejected so a typo cannot silently create a dead setting, and bounds stop
 * a slip (0 devices, a negative TTL) from taking a feature down. The value replaces the row.
 *
 * Keep in step with the *_CONFIG_FALLBACK constants in apps/api/src/lib/app-config.ts.
 */
const int = (min: number, max: number) => z.number().int().min(min).max(max);

export const CONFIG_SCHEMAS = {
  auth: z.object({ max_active_devices: int(1, 10) }).strict(),
  /** Raising this above the newest published build locks every user out until they update — see ADR 0013. */
  app: z.object({ min_app_version: z.string().regex(/^\d{1,5}\.\d{1,5}\.\d{1,5}$/, 'Use major.minor.patch, e.g. 1.4.0.') }).strict(),
  onboarding: z.object({ max_applicants: int(1, 50) }).strict(),
  nulla_osta: z.object({ validity_months: int(1, 36), expiry_warning_days: int(1, 365) }).strict(),
  checklist: z.object({ free_preview_items: int(0, 100) }).strict(),
  uploads: z
    .object({
      max_file_bytes: int(1_024, 52_428_800),
      max_bytes_per_user: int(1_048_576, 5_368_709_120),
      upload_url_ttl_seconds: int(60, 3_600),
      view_url_ttl_seconds: int(30, 3_600),
      deleted_retention_days: int(1, 365),
      allowed_mimes: z.array(z.enum(['image/jpeg', 'image/png', 'application/pdf'])).min(1).max(3),
    })
    .strict(),
  today: z
    .object({
      max_actions: int(1, 20), expiry_window_days: int(1, 365), batch_size: int(1, 50_000), min_age_minutes: int(1, 1_440),
    })
    .strict(),
  verification: z
    .object({
      hash_sweep_batch: int(1, 45), fetch_timeout_ms: int(1_000, 25_000), max_body_bytes: int(10_000, 10_000_000),
      failure_alert_after: int(1, 100), recheck_after_hours: int(1, 720),
    })
    .strict(),
  notifications: z
    .object({
      push_max_per_run: int(1, 45), push_max_attempts: int(1, 10), retention_days_read: int(7, 3_650), retention_batch: int(100, 50_000),
    })
    .strict(),
  reminders: z
    .object({ days_before: z.array(int(1, 365)).min(1).max(8), batch_size: int(100, 50_000) })
    .strict(),
  privacy: z
    .object({
      reauth_window_seconds: int(30, 3_600), export_retention_days: int(1, 90), export_cooldown_hours: int(0, 720),
      export_download_ttl_seconds: int(60, 3_600), delete_objects_per_run: int(1, 45), max_attempts: int(1, 100),
      export_row_cap: int(100, 100_000),
    })
    .strict(),
  support: z
    .object({
      topics_free: z.array(z.enum(['payment', 'order', 'courier', 'refund', 'account', 'app_problem', 'presales'])).max(7),
      messages_per_hour: int(1, 500), attachment_max_bytes: int(10_240, 10_485_760),
      attachment_upload_ttl_seconds: int(60, 3_600), retention_months: int(1, 120),
    })
    .strict(),
  sla: z
    .object({
      support_paid_hours: int(1, 336),
      support_free_hours: int(1, 336),
      working_hours_windows: z
        .object({
          utc_offset_minutes: int(-720, 840),
          days: z.array(int(1, 7)).min(1).max(7),
          start_minute: int(0, 1_439),
          end_minute: int(1, 1_440),
        })
        .strict()
        .refine((w) => w.end_minute > w.start_minute, { message: 'end_minute must be after start_minute.', path: ['end_minute'] }),
      /** COPY, per language. Screened for verdict language by the service. English is required when present. */
      working_hours_text: z.record(z.string().regex(/^[a-z]{2}$/), z.string().trim().min(1).max(200)).refine((t) => 'en' in t, {
        message: 'An English text is required.',
      }).optional(),
    })
    .strict(),
} as const;

export type ConfigKey = keyof typeof CONFIG_SCHEMAS;
export const CONFIG_KEYS = Object.keys(CONFIG_SCHEMAS) as ConfigKey[];

export const configKeyParamSchema = z.object({ key: z.enum(Object.keys(CONFIG_SCHEMAS) as [ConfigKey, ...ConfigKey[]]) });
export const putConfigSchema = z.object({ value: z.record(z.unknown()) }).strict();

export interface ConfigEntry {
  key: ConfigKey;
  value: Record<string, unknown>;
  /** True when no row exists yet and the built-in fallback is in force. */
  isDefault: boolean;
  description: string | null;
  updatedBy: string | null;
  updatedAt: string | null;
}

// ---- admin overview (Screen 31) ----
export interface AdminOverview {
  /** Present only for sections the admin may see (their scope, read_only, or super). */
  support?: { awaitingSupport: number; breached: number; unassigned: number };
  verification?: { openHashFlags: number; unreachableSources: number; drafts: number; awaitingPublish: number };
  legal?: { draftVersions: number };
  privacy?: { openRequests: number; oldestOpenAt: string | null };
}
