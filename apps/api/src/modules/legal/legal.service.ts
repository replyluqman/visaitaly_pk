import { sql } from 'drizzle-orm';
import type {
  CurrentLegalResponse,
  LegalDocType,
  LegalDocumentResponse,
  LegalVersionSummary,
  OnboardingState,
} from '@visaitaly/shared';
import type { Db } from '../../db/client.js';
import { AppError } from '../../lib/errors.js';
import { recomputeOnboardingState } from '../onboarding/onboarding.service.js';

type LegalRow = {
  id: string;
  doc_type: LegalDocType;
  locale: string;
  version: string;
  title: string;
  is_mandatory: boolean;
  published_at: string | null;
  accepted: boolean;
}

function toSummary(r: LegalRow): LegalVersionSummary {
  return {
    id: r.id,
    docType: r.doc_type,
    locale: r.locale,
    version: r.version,
    title: r.title,
    isMandatory: r.is_mandatory,
    publishedAt: r.published_at ? new Date(r.published_at).toISOString() : null,
    accepted: r.accepted,
  };
}

/**
 * Acceptance is matched on (doc_type, version) rather than version id: the same
 * terms in a different locale are the same agreement, so accepting the English
 * 1.0 disclaimer must not re-prompt an Urdu user. This assumes version strings
 * are kept in lockstep across locales when publishing (Screens §44).
 */
const ACCEPTED_PREDICATE = (userId: string) => sql`
  EXISTS (
    SELECT 1
      FROM legal_acceptances a
      JOIN legal_versions av ON av.id = a.legal_version_id
     WHERE a.user_id = ${userId}
       AND av.doc_type = v.doc_type
       AND av.version  = v.version
  )
`;

/**
 * GET /v1/legal/current — Screens §4 (gate) and §29 (Settings).
 * DISTINCT ON prefers the requested locale and falls back to 'en' per document
 * in a single round trip. Bodies are excluded; the gate fetches them one at a
 * time so this response stays small.
 */
export async function listCurrentLegal(
  db: Db,
  userId: string,
  locale: string,
): Promise<CurrentLegalResponse> {
  const result = await db.execute<LegalRow>(sql`
    SELECT DISTINCT ON (v.doc_type)
           v.id, v.doc_type, v.locale, v.version, v.title, v.is_mandatory, v.published_at,
           ${ACCEPTED_PREDICATE(userId)} AS accepted
      FROM legal_versions v
     WHERE v.is_current AND v.locale IN (${locale}, 'en')
     ORDER BY v.doc_type, (v.locale = ${locale}) DESC
  `);

  const documents = result.rows.map(toSummary);
  return {
    documents,
    requiresAcceptance: documents.some((d) => d.isMandatory && !d.accepted),
  };
}

/** GET /v1/legal/current/:docType — the full text for one document. */
export async function getCurrentLegalDocument(
  db: Db,
  userId: string,
  docType: LegalDocType,
  locale: string,
): Promise<LegalDocumentResponse> {
  const result = await db.execute<LegalRow & { body_md: string }>(sql`
    SELECT v.id, v.doc_type, v.locale, v.version, v.title, v.is_mandatory, v.published_at,
           v.body_md,
           ${ACCEPTED_PREDICATE(userId)} AS accepted
      FROM legal_versions v
     WHERE v.is_current AND v.doc_type = ${docType} AND v.locale IN (${locale}, 'en')
     ORDER BY (v.locale = ${locale}) DESC
     LIMIT 1
  `);

  const row = result.rows[0];
  if (!row) throw AppError.notFound('No published version of that document.');
  return { ...toSummary(row), bodyMd: row.body_md };
}

/**
 * POST /v1/legal/accept — Screens §4, blocking accept.
 *
 * The client sends the ids it was shown so a version published mid-session
 * cannot be silently marked accepted. Any id that is not current is rejected,
 * and every mandatory current document must be covered — a partial accept is a
 * validation failure, not a partial gate pass (PRD §18).
 */
export async function acceptLegal(
  db: Db,
  userId: string,
  deviceId: string,
  versionIds: string[],
  appVersion?: string,
): Promise<{ acceptedVersionIds: string[]; onboardingState: OnboardingState }> {
  return db.transaction(async (tx) => {
    const current = await tx.execute<{ id: string; doc_type: string; is_mandatory: boolean }>(sql`
      SELECT id, doc_type, is_mandatory FROM legal_versions WHERE is_current
    `);

    const currentIds = new Set(current.rows.map((r) => r.id));
    const unknown = versionIds.filter((id) => !currentIds.has(id));
    if (unknown.length > 0) {
      throw AppError.validation({
        versionIds: ['One or more versions are no longer current. Reload the terms and retry.'],
      });
    }

    const chosen = current.rows.filter((r) => versionIds.includes(r.id));
    const chosenDocTypes = new Set(chosen.map((r) => r.doc_type));
    const missing = current.rows
      .filter((r) => r.is_mandatory && !chosenDocTypes.has(r.doc_type))
      .map((r) => r.doc_type);
    if (missing.length > 0) {
      throw AppError.validation({
        versionIds: [`Acceptance is required for: ${[...new Set(missing)].join(', ')}.`],
      });
    }

    // ON CONFLICT DO NOTHING: re-accepting is a harmless retry, and the first
    // acceptance timestamp is the one with evidential value.
    for (const id of versionIds) {
      await tx.execute(sql`
        INSERT INTO legal_acceptances (user_id, legal_version_id, device_id, app_version)
        VALUES (${userId}, ${id}::uuid, ${deviceId}::uuid, ${appVersion ?? null})
        ON CONFLICT (user_id, legal_version_id) DO NOTHING
      `);
    }

    return {
      acceptedVersionIds: versionIds,
      onboardingState: await recomputeOnboardingState(tx, userId),
    };
  });
}
