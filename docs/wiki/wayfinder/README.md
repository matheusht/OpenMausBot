# Wayfinder Map — openmausbot-port v1

## Destination
A bot on OpenMausBot owns a business process end-to-end — autonomously, across restarts,
4+ hours — measured by the avenza benchmark through MausBotDriver, with every capability
carrying a before/after delta vs the stock-mausbot baseline and the avenza run15 reference.

## Notes
- Domain: local-first agent harness (chat UI, CLI drivers, approval cards, computers).
- Skills to consult: codebase-design, to-tickets, implement, prototype, triage, grilling.
- Standing preferences: additive-first landings; behavior-preserving extractions; wiki logged
  every session; never push upstream.

## Decisions so far
- 0001 port shape (benchmark-driven, 3 checkpoints, wiki memory) — accepted
- 0002 spine on SQLite, no infra transplant — accepted
- 0003 suspendable turns = chain-of-rounds over resumeCursor; engine extraction first — accepted
- 0004 deepseek-v4-flash rides opencode-go ACP — proposed (needs Zen catalog verification)
- 0005 benchmark seam = HarnessDriver contract + gated internal routes — accepted
- 0006 CP1 deferred to autonomous continuation — accepted (overridable at CP2/CP3)

## Frontier (open tickets on fork issues, label wayfinder:*)
- [research] Verify OpenCode Zen serves deepseek-v4-flash through opencode-go (confirms 0004)
- [task] PR-1 turn-engine extraction (behavior-preserving move into server/engine/)
- [task] event-log.ts + events.db (commit-before-publish, migrations, reconciler drain)
- [task] goals.ts chain-of-rounds + boot reconciler (orphan pgid sweep, tmpdir sweep)
- [task] budgets.ts / waves.ts / hitl.ts pure modules + unit tests
- [task] plan mode + feedback recording (log-only kinds)
- [prototype] MausBotDriver + /api/internal endpoints + seed seam
- [grilling] HITL gate semantics on approval cards (HUMAN INPUT — deferred, see 0006)

## Fog (not yet specified)
- Tier 2 novel flow identity (graduates at/after first vertical passes)
- Artifact story for mausbot (workspace files vs avenza artifact registry)
- Context-economy metric on transcript-replay drivers (what compaction means here)

## Out of scope
- Upstream PRs to milind-soni/OpenMausBot
- Hosted/multi-tenant operation; companion/cloudflare changes
- Voice/TTS, computer-control internals (regression-protected only)
