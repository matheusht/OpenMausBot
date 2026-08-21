---
status: accepted
date: 2026-08-20
deciders: port effort (evidence: round1-mausbot-lifecycle + round1-mausbot-extraction briefs)
---

# ADR 0003 — Suspendable turns: chain-of-rounds over resumeCursor, engine extracted from index.ts

## Context
No turn survives a server restart (`store.ts:427-443`); a 4h flow makes restart/sleep exposure
near-certain. But session continuity ALREADY works: consecutive same-engine turns pass
`--resume <sessionId>` / `thread/resume`, guarded by `engineIsFresh`/`rewound`, cursors
persisted per task. The missing piece is only a durable driver of follow-up turns. Meanwhile
`server/index.ts` is a 4007-line god module; turn dispatch (1227–1631) touches ~20 closures.

## Decision
1. **Long-flow strategy = chain-of-rounds driven by a durable goal object** (avenza C1 shape),
   shading to hybrid: rounds may run long while activity streams (watchdog is activity-based,
   `turn-watchdog.ts:63-66`), but every round ends at a workflow-level budget boundary with
   state checkpointed to the goal object. Budgets replace kills as the round-ender.
   - Goal store persisted like routines.json (atomic tmp+rename), survives restarts.
   - Per-round benefits: fresh stall budget, bounded 15-min HITL windows, per-round usage as
     budget checkpoints (`store.addTaskUsage`).
   - Boot-time reconciler added: orphan sweep by pgid (requires persisting child pids/pgids —
     none exist today), stale-busy reset (exists), leaked `omb-mcp-*` tmpdirs, drain of
     unpublished outbox rows.
2. **Turn engine extracted first, behavior-preserving**: `server/engine/turn-engine.ts`
   (≤600-line guardrail) receives `{store, registry, bus, cfg, broadcast, integrations, skills}`
   via constructor injection — the house pattern (RoutineManager/TurnWatchdog). Engine modules
   never import index.ts. PR-1 moves startTurn (1227–1631) + screen pollers (1122–1225) +
   unattended marks (605–627) verbatim behind delegating shims; subscriber registration order
   preserved (load-bearing, comment at 600–604). Follow-up PRs add event-log/goals/budgets/
   hitl/waves modules without touching index.ts again.
3. Turn state machine adopts avenza's vocabulary exactly (accepted/running/awaiting_input/
   completing/succeeded/failed/stopped/cancelled/timed_out + LEGAL_TURN_TRANSITIONS) so the
   eval runner's wedge detection and terminal-drain criterion work unchanged.

## Alternatives considered
- One mega-turn in a persistent CLI session — rejected: one SIGKILL or >20min sleep forfeits up
  to 4h of work; no restart survival; context growth re-bills cache reads every message.
- Pure avenza-style single long workflow — impossible without Temporal; chain-of-rounds IS the
  suspension mechanism.

## Evidence
round1-mausbot-lifecycle.md §2 (resumeCursor already viable), §4 (crash matrix + reconciler
list), §5 (strategy evaluation), recommendation (b)→(c); round1-mausbot-extraction.md §5–6
(module layout + PR-1 plan with test coverage map).
