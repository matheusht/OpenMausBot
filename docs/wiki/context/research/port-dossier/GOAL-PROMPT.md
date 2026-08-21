# GOAL — openmausbot-port v1: avenza capabilities + benchmark, grafted onto OpenMausBot

## Mission
Port the proven avenza-harness v4 capability set (durable goals, plan mode, feedback capture,
real budgets, wave dispatch, bounded HITL, seams, composition layer, subagents, ingestion) and
its benchmark-first methodology onto **OpenMausBot** — a local-first chat harness whose agents
are real CLI processes — so a bot can OWN a business process end-to-end: autonomously,
continuously, 4+ hours, surviving crashes, driven by any model, and measured by the avenza e2e
benchmark running through a `MausBotDriver`. Work on branch `benchmark/port-v1` of YOUR fork of
github.com/milind-soni/OpenMausBot (Apache-2.0 — never push to upstream; only the user merges).

You have FULL autonomy: read code, run the service, call endpoints, run evals, use up to 128
subagents in rounds, no token anxiety. Never stop at half-done work. The 3 checkpoints below
are the ONLY permission gates.

## Fixed decisions — LOCKED, do not reopen (see docs/wiki/decisions/0001…)
- Benchmark-first; the baseline DEFINES the gap (expect it LOW — stock mausbot has zero turn
  durability); every change carries a before/after delta.
- Native reimplementation, not dependency transplant: NO Temporal, NO Postgres, NO E2B, NO R2.
  The spine lands on mausbot's own primitives — SQLite WAL (`messages.db` pattern), atomic JSON
  stores, append-only NDJSON discipline — following avenza's portable pieces: event envelope
  with `occurred_at`, per-turn monotonic seq, CAS state machines, outbox-as-table,
  commit-before-publish, A/B replay→live SSE handoff.
- Thin turn-engine spine ≤600 lines, EXTRACTED from `server/index.ts` (4k-line god module)
  into its own module via the existing seams (`server/harness/`, `server/contracts.ts`);
  product/UI concerns stay out of the engine.
- Borrow/contest/measure carried over from avenza ADR 0003: every borrowed concept gets a
  benchmark dimension and a measured verdict.
- DURABILITY IS THE HEADLINE: a suspendable-turn abstraction (persist loop state at await
  points; boot-time reconciler resumes-or-fails stuck turns) replaces what Temporal gave
  avenza for free. Crash-resume is capability #1 AND benchmark metric #4.
- No $ ceiling on this effort. Per-flow budgets: generous defaults (≥8h active, ≥1500
  iterations, cost configurable), per-turn ceilings as backstops.
- Tier 2 novel flow is PRODUCED BY WAYFINDER — do not pre-pick.
- Model: deepseek-v4-flash primary (comparability with avenza run15), wired as a custom engine
  or one new driver file (the SPI is deliberately small: one file + registration). A research
  ticket confirms the cheapest honest path at CP1; fallback documented there. Secondary
  engines (claude/codex CLIs) prove the any-model claim but are not benchmark subjects.
- Matrix: deepseek-v4-flash × {mausbot-port}; avenza's official run15 numbers are the
  cross-harness reference line per metric dimension (do not re-run avenza).
- SLOs are pass/fail gates at p95: acceptance ≤2000ms, turn ≤15min (1a) / ≤30min (1b/T2),
  resume_post ≤5000ms, live_lag ≤1000ms, replay_lag ≤2000ms.
- HITL: stop-and-ask only at gates; otherwise decide + document + record feedback. Mausbot's
  approval cards ARE the gate UI — reuse them, don't rebuild.
- Wiki + wayfinder replicated in the fork: docs/wiki/{README,log,index,decisions,context,
  benchmark,wayfinder}; tickets on the fork's GitHub issues (labels wayfinder:{map,research,
  prototype,grilling,task}). One ticket per session (research excepted).
- Skills are ALREADY installed globally (~/.pi/agent/skills/) — do not reinstall.
- User will provide sample documents for ingestion fixtures when needed.

## Protocol (every session)
1. Wiki-first: read docs/wiki/README.md, log.md (last 20), index.md, wayfinder/ map state.
   The wiki is the memory — never rely on chat history.
2. Read the map; claim ONE frontier ticket (assign yourself) before any work.
3. Work; consult the skills (grilling, domain-modeling, research, wayfinder, codebase-design,
   to-spec, to-tickets, implement, prototype, triage) by reading their SKILL.md files — adapt
   their instructions.
4. End of session: append log.md entry (`## [YYYY-MM-DD] type | title`), update index.md,
   resolve the ticket (resolution comment, close, update "Decisions so far", graduate fog →
   new tickets), write ADRs with BENCHMARK EVIDENCE, file benchmark reports.
5. Ping the user if blocked >30 min. At HITL gates: stop and ask.

## Phase 0 — Bootstrap (first act of the goal)
- Fork → branch `benchmark/port-v1` → `git push -u origin benchmark/port-v1` (the only push
  before CP3).
- Verify the harness: pnpm install, pnpm typecheck, pnpm lint, pnpm test (floor ≥1070 green);
  boot `pnpm dev:server` (:8799) + `pnpm dev` (:5199); smoke a real turn with an installed CLI
  engine end-to-end.
- Port the memory: create the docs/wiki skeleton with avenza's conventions (README/log/index/
  decisions formats); copy this dossier (6 briefs + fit evaluation) into
  docs/wiki/context/research/port-dossier/.
- Build the THINNEST viable MausBotDriver behind avenza's specified HarnessDriver interface
  (start/status/pending/resolve/stop/artifacts/openEvents(turnId, afterSeq)→AsyncIterable<
  {envelope, receivedAt}>/seedConversation) + a flag-gated eval seed endpoint. Four hard
  requirements: avenza state vocabulary, monotonic last_committed_seq, envelopes with
  occurred_at, seeding seam.
- Capture the BASELINE: full 17-scenario suite on STOCK mausbot through the driver. Expect
  structural failures (no goals/gates/skills/artifacts) — that number IS the gap definition.
  Baseline report → docs/wiki/benchmark/runs/ + appended to benchmark/README.md.
- CI honesty: confirm the test-floor wrapper actually runs the suite; note env requirements.

## Phase 1 — Deep research (rounds)
- The avenza side is largely mined: use the dossier briefs + the avenza-v1 worktree for port
  decisions; fire targeted rounds only where a decision lacks evidence.
- Mausbot rounds (2–3 × parallel subagents): fold/index.ts extraction seams; store/message-db
  transactional guarantees; registry lifecycle (reloadProviders kills ALL in-flight turns —
  design a drain/lease protocol); electron/companion constraints; long-flow economics
  (per-turn CLI child vs persistent session resume cursors).
- Produce port-fit ADRs: spine-on-SQLite design; suspendable-turn state machine;
  deepseek wiring decision; composition storage swaps (R2→local dir, E2B→bot workspace cwd).

## Phase 2 — Benchmark spec + wayfinder map (CP1 gate)
- Finalize docs/wiki/benchmark/README.md: tiers/scenarios verbatim from avenza (12 scripted +
  4 autonomous + Tier 2 template); the 12 metric dimensions verbatim; SLO gates; the
  MausBotDriver contract; runner requirements (long-flow timeouts, crash-resume scenario,
  SLO assertion mode, seeding seam).
- Wayfinder: chart the map (grilling + domain-modeling first), create tickets, wire blocking.
- ⛔ CP1 — present benchmark spec + wayfinder map to the user for review. Apply feedback.

## Phase 3 — Capability implementation (benchmark-priority order; each PR carries a
## before/after delta)
1. Turn-engine extraction + event log: pull turn execution out of index.ts into an engine
   module (≤600 lines) with avenza-style envelope events committed to SQLite BEFORE publish;
   per-turn monotonic seq; boot-time reconciler. Live proof: kill dev:server mid-turn →
   restart → turn completes correctly.
2. Goal state + continuation across turns (goals table + CAS revision + rounds; continuation
   = engine-side decision fed by store state; context_summary fed forward between rounds).
3. Plan mode as logged state (plan row + narrative event + system-prompt injection;
   plan_mode tool).
4. Feedback recording (capture-only event kind; never enters model context).
5. Real budgets (usage from turn.completed; cost = tokens × pricing; soft-80% convergence
   nudge once per class; hard breach terminates; active time excludes HITL waits).
6. Wave-batched tool dispatch (planDispatch layering, effect classes, ≤8 concurrent reads,
   solo writes, ordered result append).
7. Bounded HITL waits + reconciler (pending-set CAS machine over approval cards; timeout →
   expire → forced PENDING_EXPIRED outcome; stuck-resolving reconciler; survives restart via
   store-resume).
8. Seams: ModelProvider/ObjectStorage-equivalent interfaces (storage impl = local disk);
   the driver SPI remains the model seam.
9. Composition layer: skill catalog + package loading (local dir replaces R2) +
   script-as-tool binding executing in the bot's workspace cwd (replaces E2B sandbox) +
   gated steps as request_human_review tools mapped to approval cards.
10. Subagents: upgrade delegations into child-turn orchestration (causation_id correlation,
    concurrency cap, cumulative child budget, wall-clock cap, result-as-tool-message).
11. Ingestion: upload endpoint (basename-only paths, MIME allowlist, size/count caps,
    quarantine heuristics) + list_inputs tool into the bot workspace; eval seeding seam stays
    separate and flag-gated.
Stretch (only after must-haves, same delta discipline): redaction_class wiring into
decision-log; repeat-detector upgraded from observer to enforcer; delegation depth >1 with
budgets; routine runs resumable instead of failed-on-boot.

## Phase 4 — Benchmark runs + measurement
- Full Tier 1a (12) + Tier 1b (4 autonomous) + Tier 2 (wayfinder-produced flow) on the port.
- Crash-resume continuity LIVE (kill/resume mid-flow). HITL necessity, cost per flow, context
  economy, tool hygiene, degradation (injected provider errors), parallelism, artifact quality.
- Matrix: deepseek-v4-flash × mausbot-port; compare against avenza run15 reference numbers per
  dimension.
- Reports → docs/wiki/benchmark/runs/ + index. Failures = new work items, never silence.

## ⛔ CP2 — present first vertical passing on the port + first capability + measured delta
## to the user. Apply feedback.

## Phase 5 — Iterate until DONE (feedback loops: benchmark → wiki → wayfinder → checkpoints)

## ⛔ CP3 — final review. Full benchmark report + per-metric before/after deltas vs baseline
## AND vs avenza run15 reference + updated borrow/contest/measure verdicts + merge decision
## (only user merges; NEVER push upstream).

## DONE (exit criteria — ALL must hold)
1. Baseline captured AND final benchmark green: Tier 1a 12/12 + Tier 1b/Tier 2 at
   CP-adjusted targets, reproducible via documented commands.
2. All capabilities landed, tested, and measured with before/after deltas; live crash-resume
   proof (kill mid-turn → resume → PASS).
3. Matrix executed vs avenza run15 reference line; reports filed in wiki/benchmark.
4. Research complete: dossier mined, mausbot rounds filed, port-fit ADRs with evidence.
5. Wiki complete and current: every decision ADR'd with evidence, wayfinder map fully
   resolved (frontier empty, fog graduated), log + index current, lint pass at CP3.
6. Quality: pnpm typecheck + lint + full test floor green (~1070 existing tests unbroken —
   chat, approvals, computers, voice still work); turn-engine module ≤600 lines; paired
   migrations for any schema change; CI honest.
7. Final report: before/after deltas per metric dimension, capability-by-capability; what to
   do next (fresh wayfinder tickets if the destination grew).

## Constraints
- Never reopen locked decisions without a new ADR + user approval.
- NEVER push to upstream milind-soni/OpenMausBot; keep LICENSE/NOTICE/third_party provenance
  intact; avenza-derived files carry a header comment noting origin repo + license.
- No schema change without paired migration; no dynamic code inside the turn engine; do not
  touch user secrets/keychain/config credentials.
- Do not regress product surfaces — the existing suites are the regression net.
- Benchmark claims must be reproducible: every report cites exact commands/run ids.
- The wiki is the truth of record — if you don't log it, it didn't happen.

---
Setup notes: kick off as a /goal in pi on the OpenMausBot clone, already on
benchmark/port-v1; Phase 0 pushes the branch (the only push before CP3); the research dossier
lives at ../openmausbot-port/ (copy into docs/wiki/context/research/port-dossier/ during
Phase 0); wayfinder map charted in Phase 2; you need a GitHub fork of OpenMausBot under your
account BEFORE kickoff (wayfinder tickets live on its issues).
