-- Rollback for 0013. Drops every support conversation and attachment ROW. R2 attachment objects are NOT removed by SQL —
-- list and delete them first on any environment with real users. Export the threads first if they must be kept.
DELETE FROM app_config WHERE key IN ('support','sla');
DROP TABLE IF EXISTS support_attachments;
DROP TABLE IF EXISTS support_messages;
DROP TABLE IF EXISTS canned_responses;
DROP TABLE IF EXISTS support_threads;
