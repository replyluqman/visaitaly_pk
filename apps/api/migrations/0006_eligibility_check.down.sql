-- Rollback for 0006. Drops every published Quick Check version (copy is re-seedable / re-publishable).
DROP TABLE IF EXISTS eligibility_check_versions;
