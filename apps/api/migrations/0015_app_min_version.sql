-- 0015_app_min_version (ADR 0013): the server-side switch that lets old app builds be forced to update at the
-- native-auth cutover (or any breaking change). "0.0.0" blocks nobody; raise it in the config editor when needed.
-- Config default, not content (ADR 0007).
INSERT INTO app_config (key, value, description) VALUES
  ('app', '{"min_app_version": "0.0.0"}'::jsonb,
   'Oldest app build allowed to register a session. Older builds get APP_UPDATE_REQUIRED (426). Format: major.minor.patch.')
ON CONFLICT (key) DO NOTHING;
