---
name: Feature / change request
about: Propose new behaviour or a change to existing behaviour
labels: enhancement
---

## Problem

What can the user (or admin, or developer) not do today?

## PRD / Screens reference

Is this in `docs/VisaItalyPK-PRD-v3_1.md`? Which §, which screen? If it is **not** in the PRD it is a scope change — say so, and expect an evaluation before any implementation.

## Proposed behaviour

## SaaS-level check

- **Scale:** rows added at 30k users? any new unbounded table (needs a retention rule)?
- **Request path:** does it add CPU to a user-facing request (10 ms ceiling), or can it run in a Cron Worker?
- **Security / privacy:** new PII? new admin surface? new audit-log events?
- **Cost:** new vendor or recurring cost? (PRD §4 — the stack is locked)
- **Legal:** does user-facing copy change? (PRD §18 copy rules; lawyer-review scope)

## Alternatives considered
