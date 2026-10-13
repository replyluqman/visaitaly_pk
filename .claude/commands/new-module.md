---
description: Start a new backend module from the template, design first, no code until agreed
argument-hint: <number> <name>
---

Start Module $ARGUMENTS for VisaItaly PK.

1. Read `CLAUDE.md`, `docs/ROADMAP.md`, `STATE.md`. Confirm the previous module has
   passed all five gates in `docs/TESTING.md`. If not, stop and list what is missing.
2. Read the PRD and Screens sections this module serves.
3. Copy `docs/MODULE-TEMPLATE.md` to `apps/api/MODULE-<NN>-<NAME>.md` and fill
   sections 1–5 (purpose, scope, contract, data, decisions). Include rows-at-30k and
   retention for every new table, and the index each query uses.
4. List open questions and anything that would be a breaking change.
5. **Stop.** Present the design for confirmation. Do not write migrations or code
   until the user confirms.
