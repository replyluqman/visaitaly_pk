-- Rollback for 0007. Drops document METADATA and the Today cache. R2 objects are NOT removed by SQL:
-- before rolling back anywhere that holds real uploads, list and delete the bucket objects first
-- (or the files become orphaned and undeletable by the app).
DELETE FROM app_config WHERE key IN ('uploads','today');
DROP TABLE IF EXISTS next_actions;
DROP TABLE IF EXISTS documents;
