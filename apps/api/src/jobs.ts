import type { Db } from './db/client.js';
import type { PushSender } from './lib/fcm.js';
import type { IdentityDeleter } from './lib/identity.js';
import type { ObjectStore } from './lib/storage.js';
import { sweepSources, type SourceFetcher } from './modules/cms/cms.service.js';
import { purgeStaleDocuments } from './modules/documents/documents.service.js';
import {
  dispatchPush, dispatchRequirementUpdates, generateReminders, purgeReadNotifications,
} from './modules/notifications/notifications.service.js';
import { processErasures, processExports } from './modules/privacy/privacy.service.js';
import { refreshNextActions } from './modules/today/today.service.js';

export interface JobDeps {
  store: ObjectStore;
  /** Undefined when FCM_SERVICE_ACCOUNT is not configured: push is skipped, the inbox still fills. */
  pushSender?: PushSender;
  fetcher?: SourceFetcher;
  /** Undefined when no service account is configured: erasure still runs, the Firebase login is left for manual removal and recorded. */
  identity?: IdentityDeleter;
}

export type JobReport = Record<string, { ok: true; result: unknown } | { ok: false; error: string }>;

/**
 * Everything that must never run on a user request (PRD §4, §14, §15), as ONE tick of ONE cron
 * (every 5 minutes). Each job is self-limiting and idempotent, so running all of them every tick is safe:
 * the sweep only touches sources not checked for `recheck_after_hours`, the Today refresh only rows older
 * than `min_age_minutes`, reminders dedupe per threshold. One cron instead of several because Cloudflare
 * caps cron triggers per account.
 *
 * Jobs are independent: one throwing is reported and the rest still run, so a broken FCM key cannot
 * stop reminders being written. Order matters only loosely — notifications are generated before the
 * push step so a fresh publish is sent in the same tick.
 */
export async function runScheduledJobs(db: Db, deps: JobDeps): Promise<JobReport> {
  const jobs: Array<[string, () => Promise<unknown>]> = [
    ['requirement_updates', () => dispatchRequirementUpdates(db)],
    ['reminders', () => generateReminders(db)],
    ['push', () => dispatchPush(db, deps.pushSender)],
    ['erasures', () => processErasures(db, deps.store, deps.identity)],
    ['exports', () => processExports(db, deps.store)],
    ['next_actions', () => refreshNextActions(db)],
    ['source_hash_sweep', () => sweepSources(db, deps.fetcher)],
    ['document_retention', () => purgeStaleDocuments(db, deps.store)],
    ['notification_retention', () => purgeReadNotifications(db)],
  ];
  const report: JobReport = {};
  for (const [name, run] of jobs) {
    try {
      report[name] = { ok: true, result: await run() };
    } catch (err) {
      report[name] = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
  return report;
}
