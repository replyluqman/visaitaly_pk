-- Rollback for 0010. Drops every notification (the inbox is the user-facing record — export first on any
-- environment with real users), preferences and templates.
UPDATE app_config SET value = value - 'min_age_minutes' WHERE key = 'today';
UPDATE app_config SET value = value - 'recheck_after_hours' WHERE key = 'verification';
DELETE FROM app_config WHERE key IN ('notifications','reminders');
DROP TABLE IF EXISTS notification_dispatch;
DROP TABLE IF EXISTS notification_preferences;
DROP TABLE IF EXISTS notifications;
DROP TABLE IF EXISTS notification_templates;
