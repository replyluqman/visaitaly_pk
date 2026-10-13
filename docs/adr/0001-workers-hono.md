# 0001 — Cloudflare Workers + Hono for the API
Status: Accepted (PRD §4, locked) | Date: 2026-09

## Context
Paid app, cost-sensitive, solo/small team, Pakistan + Italy users. Needs a cheap
flat-rate API that scales without ops.

## Decision
The API is one Cloudflare Worker using Hono. Cron Triggers for scheduled work.

## Consequences
- Free tier: 100k req/day, **10 ms CPU per request** — the binding constraint.
  Every design is checked against it; heavy work goes to Cron.
- No persistent process: no global DB pool, no in-memory cache across requests.
- Escape hatch: Workers Paid ($5/mo) raises CPU to 30 s. Use it before redesigning.

## Alternatives considered
Node on a VPS (ops burden, fixed cost), serverless functions on other clouds
(egress cost, cold starts). Rejected in PRD §4.
