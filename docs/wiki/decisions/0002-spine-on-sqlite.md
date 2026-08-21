---
status: accepted
date: 2026-08-20
deciders: port effort (evidence: round1-mausbot-sqlite brief)
---

# ADR 0002 — Spine lands on OpenMausBot's own primitives (SQLite), no infrastructure transplant

## Context
avenza's spine runs on Temporal Cloud + Postgres + E2B + R2. OpenMausBot is a single-process
Node server (Node ≥24) whose persistence is `node:sqlite` WAL (`messages.db`), atomic JSON
files, and append-only NDJSON tees. Porting avenza's *infrastructure* would destroy the
local-first product constraint.

## Decision
Reimplement the spine natively on mausbot primitives, following avenza's portable pieces:

- **events.db** beside messages.db (own `DatabaseSync` handle — verified two handles coexist),
  created 0600, `PRAGMA journal_mode=WAL`, **`PRAGMA synchronous=FULL`** (deliberate divergence:
  commit durability for the event log; messages.db stays NORMAL).
- Envelope = avenza's HarnessEventSchema adapted: `{schema_version, event_id(uuidv7), turn_id,
  seq, occurred_at, family, kind, item_id?, causation_id?, trace_id?, payload}`; zod-validated;
  `redactSecrets(envelope)` BEFORE INSERT (matches avenza secret-scan-before-commit).
- Table `events` PK `(turn_id, seq)`; monotonic seq via `MAX(seq)+1` inside `BEGIN IMMEDIATE`
  — no advisory locking needed (single writer; node:sqlite synchronous). busy_timeout set.
- Commit-before-publish: event row + outbox row (`event_outbox(turn_id, seq, published)`) in
  one txn; publish after COMMIT; boot-time reconciler drains unpublished rows.
- CAS everywhere via `UPDATE … WHERE state=$from / revision=$n`, check `changes===1`.
- Migrations: `PRAGMA user_version` counter + ordered thunks, DDL + version bump in one txn
  (paired-migration requirement satisfied); base DDL keeps `IF NOT EXISTS` so fresh/upgraded
  converge.
- NO Temporal, NO Postgres, NO E2B, NO R2. Object storage interface impl = local disk;
  sandbox = bot workspace cwd.

## Consequences
Crash-resume of mid-turn waits and child-turn orchestration must be hand-built (ADR 0003) —
this is exactly what Temporal gave avenza for free. Accepted: mausbot turns are short-lived CLI
children, so durable timers/retries shrink dramatically; the resumable state machine is the one
hard piece worth building.

## Alternatives considered
- Embed Temporal — rejected: violates local-first, adds a server dependency to a desktop app.
- Postgres — rejected same. JSON-file-only event log — rejected: no transactional CAS, no
  partial-failure story at 4h scale.

## Evidence
round1-mausbot-sqlite.md: verified multi-statement txns, prepared-statement reuse across txns,
second concurrent handle, backup API, MAX_LENGTH ~1GB, busy_timeout option; DDL sketch included.
