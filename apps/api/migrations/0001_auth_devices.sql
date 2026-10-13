-- Module 1: Auth + device sessions
-- PRD §2 (account model, 2-device limit), §5 (Neon is the single source of truth),
-- §19 (access control), Screens §1/§3/§29.

-- ---------------------------------------------------------------------------
-- shared: updated_at trigger
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- app_config: every tunable value lives here (PRD §6 "nothing hardcoded").
-- Created in Module 1 because the device limit is the first such value.
-- Pricing / SLA / grace keys are added by their own migrations later.
-- ---------------------------------------------------------------------------
CREATE TABLE app_config (
  key         text PRIMARY KEY,
  value       jsonb       NOT NULL,
  description text,
  updated_by  uuid,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

INSERT INTO app_config (key, value, description) VALUES
  ('auth', '{"max_active_devices": 2}'::jsonb,
   'PRD §2 device limit. Changing this takes effect without an app release.');

-- ---------------------------------------------------------------------------
-- users: one account = one login = many applicants (PRD §2).
-- No role column: there is no secondary role and no per-applicant login.
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firebase_uid     text        NOT NULL,
  email            text,
  display_name     text,
  onboarding_state text        NOT NULL DEFAULT 'disclaimer_pending',
  status           text        NOT NULL DEFAULT 'active',
  last_login_at    timestamptz,
  deleted_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_onboarding_state_chk CHECK (
    onboarding_state IN ('disclaimer_pending','applicants_pending','stage_pending','complete')
  ),
  CONSTRAINT users_status_chk CHECK (status IN ('active','deleted')),
  CONSTRAINT users_deleted_consistency_chk CHECK (
    (status = 'deleted') = (deleted_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX users_firebase_uid_uq ON users (firebase_uid);

-- Firebase enforces one account per email address by default; mirror that here.
-- Partial so a GDPR-deleted account does not permanently block re-signup.
CREATE UNIQUE INDEX users_email_lower_uq
  ON users (lower(email))
  WHERE email IS NOT NULL AND deleted_at IS NULL;

CREATE TRIGGER users_set_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- devices: PRD §2 max 2 active, evict oldest by last_login on the 3rd.
-- Eviction is app-level (status flag), not Firebase refresh-token revocation:
-- the Admin SDK does not run in Workers, and doing it over Identity Toolkit
-- would put service-account JWT signing on the request path (10 ms CPU ceiling).
-- device_id is a client-generated UUIDv4, never a hardware identifier.
-- ---------------------------------------------------------------------------
CREATE TABLE devices (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id     uuid        NOT NULL,
  platform      text        NOT NULL,
  app_version   text,
  os_version    text,
  model         text,
  fcm_token     text,
  status        text        NOT NULL DEFAULT 'active',
  last_login_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  evicted_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT devices_platform_chk CHECK (platform IN ('android','ios')),
  CONSTRAINT devices_status_chk   CHECK (status IN ('active','evicted','signed_out'))
);

CREATE UNIQUE INDEX devices_user_device_uq ON devices (user_id, device_id);

-- Serves both the per-request auth lookup and the eviction ORDER BY.
CREATE INDEX devices_user_active_idx
  ON devices (user_id, last_login_at DESC)
  WHERE status = 'active';

-- Notification module will fan out on this; created now to avoid a later ALTER.
CREATE INDEX devices_fcm_token_idx
  ON devices (user_id)
  WHERE status = 'active' AND fcm_token IS NOT NULL;
