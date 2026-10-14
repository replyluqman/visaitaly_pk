UPDATE app_config SET value = value - 'stale_days' WHERE key = 'verification';
