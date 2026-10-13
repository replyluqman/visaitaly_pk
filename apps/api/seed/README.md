# Dev seed

Dev-only data. **Never** part of the migration chain, never run in production.

    psql "$DATABASE_URL" -f apps/api/seed/<file>.sql

Currently empty: `app_config` and `relationships` defaults are seeded by
migration `0002` because they are schema-adjacent configuration, not content.

Module 3's requirement definitions belong **here**, not in `0003` — see
`docs/SCALE.md` and the Module 3 decisions in `STATE.md`.
