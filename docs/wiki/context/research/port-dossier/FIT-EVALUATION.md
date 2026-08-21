# Port-Fit Evaluation — avenza-harness v4 → OpenMausBot

Date: 2026-08-20 · Evidence: 6-subagent deep-read (`briefs/`), repos at
`harnesses/avenza-harness-v1` (branch `benchmark/prototype-v1`) and `harnesses/OpenMausBot`.

## Verdict

**HIGH fit, one architectural inversion.** avenza is a durability + benchmark engine with no
product surface; OpenMausBot is a product-shaped harness (chat UI, approval cards, computers,
apps, voice) with **zero durability**. The port grafts avenza's proven spine concepts +
capabilities C1–C10 + benchmark methodology onto mausbot's own primitives — natively, without
Temporal/Postgres/E2B/R2. This mirrors avenza ADR 0003's own ethos: borrow concepts,
reimplement natively, measure everything.

## Primitive mapping

| avenza primitive | OpenMausBot counterpart | Graft verdict |
|---|---|---|
| Event envelope `{seq, occurred_at, kind, payload}` | `RuntimeEvent` (contracts.ts:72–127, ~12 kinds) + NDJSON tees | Adapt: extend union, add `seq`/monotonic per-turn commit |
| Per-turn monotonic seq (advisory lock + MAX+1) | none (in-memory bus, ring buffer) | Portable as-is — single writer makes it trivial |
| CAS state machines (turns/goals/pending) | none (bots.json last-writer-wins) | Portable as-is — SQLite transactions |
| Outbox-as-table → SSE notifier | direct in-proc fan-out | Adapt: keep table for crash-audit; poll replaces SKIP LOCKED |
| A/B replay→live SSE handoff | ring buffer + STREAM_ID cursor | Replace with avenza handoff (best-in-class, no Temporal needed) |
| Durable HITL wait (`condition()`) | approval cards, uniform 15-min timeout, fail-closed | Adapt: pending-set CAS machine over cards; suspension via store-resume |
| Child workflows (subagents) | delegations (depth 1, ≤4 fan-out) | Upgrade: causation_id, budgets, caps — simpler than Temporal |
| Sandbox (E2B) + artifacts (R2) | bot workspace cwd + attachments | Swap adapters: local dir storage, exec in workspace |
| Skill catalog/packages | skill-library.ts (prompt-injection only) | Extend: script-as-tool binding + gate mapping |
| Postgres persistence | messages.db (SQLite WAL!) + atomic JSON + NDJSON | Native substrate — better than expected |
| Temporal workflow (1,430-line file) | per-turn CLI child via driver SPI | **The inversion**: build suspendable-turn engine + boot reconciler |

## Capability port difficulty (from brief B2)

Easy: C2 plan mode, C3 feedback, C4 budgets, C5 wave dispatch, C7 seams, C10 ingestion.
Easy-moderate: C8 composition. Moderate: C9 subagents. Moderate-hard: C1 goals (needs
resumable turn state machine). Hard: C6 bounded HITL waits (same suspension machinery as C1 —
build once, unlock both).

## Four hard requirements for the MausBotDriver (eval seam)

From avenza's specified-but-unimplemented `HarnessDriver` interface: (1) avenza state
vocabulary, (2) monotonic `last_committed_seq`, (3) envelope stream with `occurred_at`
(`openEvents(turnId, afterSeq) → AsyncIterable`), (4) flag-gated seed endpoint. Scenarios,
goldens, capture assertions, SLO math, wedge detection, report builder port **wholesale**.

## Top risks

1. `server/index.ts` is a 4k-line god module — extraction seams exist (harness/, contracts.ts)
   and must be used; the ≤600-line turn-engine rule forces the extraction.
2. `reloadProviders()` kills ALL in-flight turns — needs a drain/lease protocol before long flows.
3. Approvals/pendings/watchdogs are in-memory — die on restart (fail-closed fallback exists).
4. deepseek-v4-flash must ride a custom engine binary or new driver file (SPI is deliberately
   small: one file + registration) — cheapest honest path is a CP1 research ticket.
5. Existing ~1070-test floor + desktop packaging must stay green — the regression net.
6. CLI-child-per-turn economics vs 4h flows: persistent-session resume cursors exist
   (`--resume <sessionId>`); long-flow strategy needs evidence (Phase 1 round).
