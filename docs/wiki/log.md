# Log

## [2026-08-20] bootstrap | Port effort started on benchmark/port-v1
Branch created from upstream main (milind-soni/OpenMausBot @ 0.1.27). Wiki skeleton stood up;
pre-goal dossier (6 briefs, fit evaluation, goal prompt) filed under context/research/port-dossier/.
Fork + push deferred pending user go-ahead; wayfinder map comes at Phase 2 (CP1).

## [2026-08-20] wayfinder | Phase 2 charted — fork live, map + tickets filed
Fork matheusht/OpenMausBot created; benchmark/port-v1 pushed (tracking fork). Benchmark spec
(benchmark/README.md) + wayfinder map + ADR 0006 (CP1 deferred per user authorization,
overridable at CP2/CP3) landed. Tickets #1–#8 on the fork (map, research deepseek-zen, tasks
PR-1/event-log/goals/pure-modules, prototype driver+seed, grilling HITL left OPEN for human).

## [2026-08-20] implement | P3a additive engine modules — 35 tests green
server/engine/: event-log.ts (events.db, envelope commit-before-publish, CAS turn states,
user_version migrations), budgets.ts (4 classes, soft-80%/hard), waves.ts (Kahn layering,
≤8 reads, solo writes — reads-first policy chosen by test), goals.ts (chain-of-rounds
GoalManager: structural round reservation = one in-flight round, continuation decision,
prompt synthesis, restart survival), hitl.ts (bounded waits over injected subscription),
plan-state.ts (whole-value fold + narrative events), feedback.ts (log-only, contract A).
Gates per module: vitest + typecheck + oxlint engine-clean. Feedback-loop fixes: mkdir before
open, test isolation via setup.ts HOME redirect (not OMB_DATA_DIR), duplicate-round guard =
one in-flight round, reads-first wave policy, SAFETY comments per anti-slop lint.
Next: event-mapper + bus wiring (append-only subscriber), then PR-1 extraction (#3).

## [2026-08-20] implement | Durable event log LIVE in the server — full suite green
event-mapper.ts (RuntimeEvent → avenza envelope families; lossless narrative/status fallback)
+ reconciler.ts (outbox drain, age-gated omb-mcp-* tmpdir sweep). Wired into index.ts as the
FIRST bus subscriber — every downstream consumer (watchdog clock, fold, SSE) now only sees
committed events; shutdown closes events.db. Regression net: FULL pnpm test green — 142 files,
1390 passed/12 skipped, floor 1402≥1070, packaged-server smoke + broker + updater all pass.
Commits 2980f62..b9e7baa pushed to fork. Next frontier: #3 PR-1 turn-engine extraction
(plan filed in round1-mausbot-extraction.md §6), then #7 MausBotDriver + /api/internal seam.

## [2026-08-20] implement | Eval seam v0 live — MausBotDriver surface served
/api/internal/eval/{turns,status,events,seed} behind authorizedComms OR a dedicated
OMB_EVAL_TOKEN bearer (dev-rig only; electron never sets it). Turn state machine (avenza
vocabulary) now folds off the bus stream into events.db: accepted→running→awaiting_input→
terminal with last_committed_seq + tool-call iteration proxy. event-log migration v2 adds
thread_id for thread→turn resolution. Smoke-verified against a live server in a throwaway
HOME: 401 unauth ✓, seed writes basename-only fixtures ✓, status {state, current_iteration,
last_committed_seq, pending_set_id} ✓, replay after=N ✓. Lint parity with base on index.ts
(63=63); typecheck clean; engine 43/43. Commit 0b0956f. Incident note: first smoke attempt
leaked a test bot into repo-local .openmausbot (HOME redirect failed on missing mkdtemp) —
cleaned; real home untouched. Next: #3 PR-1 extraction, then MausBotDriver client + baseline.

## [2026-08-20] research | Phase 1 complete — 2 rounds, 6 briefs, 5 ADRs
Round 1 (mausbot): long-flow lifecycle (chain-of-rounds recommended; crash matrix + reconciler
sweep list), index.ts extraction seams (server/engine/ layout + behavior-preserving PR-1),
node:sqlite substrate (verified live; events.db DDL sketch). Round 2: electron/packaging gates,
deepseek wiring (opencode-go path A/B, ~0–10 LOC), avenza contract catalog. ADRs 0001–0005
filed; 0004 proposed pending CP1 verification that Zen serves deepseek-v4-flash.
