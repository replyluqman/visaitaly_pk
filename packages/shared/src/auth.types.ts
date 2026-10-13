import { z } from 'zod';
import type { LegalDocType } from './legal.types.js';

/** Onboarding progress — Splash (Screen 1) routes on this. */
export const OnboardingState = {
  DISCLAIMER_PENDING: 'disclaimer_pending',
  APPLICANTS_PENDING: 'applicants_pending',
  STAGE_PENDING: 'stage_pending',
  COMPLETE: 'complete',
} as const;
export type OnboardingState = (typeof OnboardingState)[keyof typeof OnboardingState];

export const DevicePlatform = { ANDROID: 'android', IOS: 'ios' } as const;
export type DevicePlatform = (typeof DevicePlatform)[keyof typeof DevicePlatform];

export const DeviceStatus = {
  ACTIVE: 'active',
  EVICTED: 'evicted',
  SIGNED_OUT: 'signed_out',
} as const;
export type DeviceStatus = (typeof DeviceStatus)[keyof typeof DeviceStatus];

// ---------- requests ----------

/**
 * POST /v1/auth/session body.
 * device_id is a client-generated UUIDv4 held in flutter_secure_storage.
 * Never a hardware identifier: Play policy risk + ANDROID_ID resets on reinstall,
 * which would silently burn device slots.
 */
export const registerSessionSchema = z.object({
  deviceId: z.string().uuid(),
  platform: z.enum([DevicePlatform.ANDROID, DevicePlatform.IOS]),
  appVersion: z.string().min(1).max(32),
  osVersion: z.string().max(64).optional(),
  model: z.string().max(128).optional(),
  /** Registered here so push works from first launch; refreshed on token rotation. */
  fcmToken: z.string().max(512).optional(),
});
export type RegisterSessionInput = z.infer<typeof registerSessionSchema>;

export const deviceIdParamSchema = z.object({ deviceId: z.string().uuid() });

// ---------- responses ----------

export interface DeviceSummary {
  deviceId: string;
  platform: DevicePlatform;
  model: string | null;
  appVersion: string | null;
  lastLoginAt: string;
  lastSeenAt: string;
  /** True for the device making this request — Account screen labels it "This device". */
  isCurrent: boolean;
}

/**
 * Entitlement is resolved from Neon on every launch (PRD §5).
 * Never from Firebase custom claims.
 *
 * Buckets are computed defensively against now() rather than trusting
 * premium_status alone — the Cron expiry sweep may not have run yet.
 */
export interface Entitlement {
  /** Applicant ids with live premium access. */
  premiumApplicantIds: string[];
  /** Applicant ids in the PRD §7 grace period: full read, no writes. */
  graceApplicantIds: string[];
  hasAnyPremium: boolean;
}

/** GET /v1/me and POST /v1/auth/session both return this. */
export interface MeResponse {
  user: {
    id: string;
    email: string | null;
    displayName: string | null;
    onboardingState: OnboardingState;
    createdAt: string;
  };
  entitlement: Entitlement;
  devices: {
    /** From app_config, not hardcoded. */
    maxActive: number;
    activeCount: number;
  };
  /**
   * PRD §18 version stamping. Non-empty pendingDocTypes => route to the
   * Disclaimer Gate, including for an existing user after a version bump.
   * Doc types, not version ids, because /me is locale-agnostic — the client
   * fetches the bodies from /v1/legal/current in its own locale.
   */
  legal: {
    requiresAcceptance: boolean;
    pendingDocTypes: LegalDocType[];
  };
  /**
   * declaredCount is the Screen 5 answer (intent). total is the truth.
   * awaitingStage drives the Screen 7 resume point.
   */
  applicants: {
    declaredCount: number | null;
    total: number;
    awaitingStage: number;
  };
}

/** POST /v1/auth/session response. */
export interface RegisterSessionResponse extends MeResponse {
  session: {
    /** Devices evicted by this login. Non-empty => oldest session was silently dropped. */
    evictedDeviceIds: string[];
    isNewUser: boolean;
  };
}
