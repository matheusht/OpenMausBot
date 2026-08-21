# Benchmark — openmausbot-port

Status: PROVISIONAL (CP1 deferred per ADR 0006; overridable at CP2/CP3).
Methodology ported from avenza-harness v4 (see context/research/port-dossier/briefs/avenza.md §1–5).

## Tiers
- **Tier 1a — 12 scripted scenarios** (4 vertical skills × happy / escalation-heavy /
  hard-block), prompts and goldens ported verbatim from avenza `apps/eval` once the
  composition layer (skill binding + script-as-tool + gates) lands.
- **Tier 1b — 4 autonomous scenarios**: same fixtures/goldens/gates as each happy path,
  minimal prompt ("Process X in {dir} using {skill} and produce Y").
- **Tier 2 — novel flow**: identity produced by wayfinder (fog item); spec template = avenza's.

## The 12 metric dimensions (verbatim from avenza)
1. Completion rate — terminal `succeeded` / started turns
2. Golden fidelity — artifact JSON checks vs frozen goldens (eq/approx/gt/gte/lt/lte, dot-paths, tolerance 0.005)
3. Process fidelity — skill scripts in order, no silent skips, gate count == expected
4. Crash-resume continuity — kill server mid-turn → restart → turn/goal continues (LIVE proof required)
5. HITL necessity rate — gates opened == gates expected, no spurious extras
6. Budget awareness — completes within per-flow budget
7. Cost per completed flow — USD per successful e2e (real usage accounting; ACP indicator-only caveat per ADR 0004)
8. Context economy — memory tool usage, compaction events, context-token trajectory
9. Tool hygiene — duplicates, failed calls, effect-class discipline
10. Degradation behavior — injected provider errors: clean retry vs orphaned turn
11. Artifact quality — quarantine pass rate + cell-level golden checks
12. Parallelism — read waves ≤8 vs serial; subagent fan-out

## SLO gates (pass/fail at p95)
acceptance_ms ≤2000 · turn_ms ≤15min (1a) / ≤30min (1b/T2) · resume_post_ms ≤5000 ·
live_lag_ms ≤1000 · replay_lag_ms ≤2000. p95 = sorted[ceil(n·0.95)−1]; breach ⇒ run fails
`slo_gate_breach`.

## MausBotDriver contract (ADR 0005)
Implements avenza HarnessDriver: startTurn / turnStatus / pendingSet / resolvePending /
stopTurn / listArtifacts / downloadArtifactBytes / openEvents(turnId, afterSeq)→AsyncIterable<
{envelope, receivedAt}> / seedConversation. Server must expose: TurnStatus with avenza state
vocabulary + current_iteration + last_committed_seq; SSE frames `id: <seq>` with canonical
envelope JSON; flag-gated seed endpoint under /api/internal/.

## Runner requirements
Long-flow timeouts (tiered) · crash-resume scenario (`--resume <turn_id>` reattach via
last_committed_seq) · SLO assertion mode · driver abstraction (avenza FetchHarnessClient →
AvenzaHttpDriver; new mausbot.ts driver) · seeding seam separate from public ingestion.

## Baseline plan
1. Build thinnest MausBotDriver + seed seam against STOCK mausbot (no capabilities).
2. Run full suite → expected structural failures (no goals/gates/skills/artifacts). That number
   IS the gap definition ("before" for every delta).
3. File report in runs/ citing exact commands, commit sha, run ids.

## Model under test
deepseek-v4-flash via opencode-go (ADR 0004). Secondary engines prove any-model claim only.

## Runs
- runs/ — reports `<date>-<tier>-<flow>-<harness>.md|.json`; failures become tickets, never silence.
