# Briefs — avenza-harness v1 (3 subagents, 2026-08-20; worktree of branch `benchmark/prototype-v1`)

## B4 — Benchmark system & decision record

### 1. Scenario set (apps/eval/src/scenarios.ts)

**Tier 1a — 12 scripted scenarios = 4 vertical skills × 3 flows** (fully-specified zero-shot prompts naming every script, absolute path, gate protocol, inline-decisions contract):

| # | Scenario | Purpose |
|---|---|---|
| 1 | ap-three-way-match / happy | Match 5 invoices vs POs/receiving reports; both gates approve-only; payable ≈ $11,000 |
| 2 | ap / escalation-heavy | 8 invoices, 7 golden decisions at exceptions-review; 6 approved/1 rejected/1 held |
| 3 | ap / hard-block | 3 invoices, 1 decision at exceptions-review; 2 approved/1 rejected |
| 4 | insurance-fnol-triage / happy | FNOL intake+triage of 3 claims, adjuster-review gate, 0 SIU referrals |
| 5 | fnol / escalation-heavy | 4 claims, 4 decisions, 1 SIU referral |
| 6 | fnol / hard-block | 4 claims, 1 decision, 0 SIU referrals |
| 7 | healthcare-eob-reconciliation / happy | Reconcile 3 EOBs vs claims, finance-review gate, all finalized, no appeals |
| 8 | eob / escalation-heavy | 4 claims, 4 decisions, 2 appeals filed |
| 9 | eob / hard-block | 4 claims, 3 decisions, 0 appeals |
| 10 | commercial-lease-abstraction / happy | Abstract 2 leases, legal-review gate, no rejections/amendments |
| 11 | lease / escalation-heavy | 1 finalized/1 rejected/2 amendments, 4 decisions |
| 12 | lease / hard-block | Same shape, 3 decisions |

**Tier 1b — 4 autonomous** (`scenario-autonomous` per skill): minimal prompt ("Process X in {dir} using {skill} and produce Y"); same fixtures/goldens/gates as the happy path; model must discover the process from the bound skill.

**Tier 2 — vendor-onboarding / happy**: novel vertical (ADR 0005), 4 vendors, compliance-review gate with 1 decision, goldens frozen from the real script chain (3 approved/0 flagged/1 rejected).

### 2. The 12 metric dimensions (benchmark/README.md)

1. Completion rate — terminal `succeeded` / started turns
2. Golden fidelity — artifact JSON checks vs frozen goldens (`eq/approx/gt/gte/lt/lte`, dot-paths, tolerance default 0.005)
3. Process fidelity — skill scripts in order, no silent skips, gate count == expected
4. Crash-resume continuity — runner crash mid-turn reattach; service kill mid-goal continues
5. HITL necessity rate — gates opened == gates expected, no spurious extras
6. Budget awareness — completes within per-flow budget
7. Cost per completed flow — USD per successful e2e (real usage accounting)
8. Context economy — memory tool usage, compaction events, context-token trajectory
9. Tool hygiene — duplicates, failed calls, effect-class discipline
10. Degradation behavior — injected provider errors: clean retry vs orphaned turn
11. Artifact quality — quarantine pass rate + cell-level golden checks
12. Parallelism — read waves ≤8 vs serial; subagent fan-out

### 3. SLO gate mechanics

Per-scenario `slo_gates` (zod-validated, `manifest.ts`): `acceptance_ms ≤2000` (POST start-turn → 202, seed excluded after live defect #15), `turn_ms ≤15min` (Tier 1a) / `≤30min` (1b/Tier 2), `resume_post_ms ≤5000`, `live_lag_ms ≤1000` (committed→SSE frame), `replay_lag_ms ≤2000`. Runner legs: seed → start → SSE stream (`after=0` replay then live; lag = receivedAt − occurred_at, classified live if occurred after stream open) → poll loop with wedge detection (fail only when NEITHER state NOR iteration advances for `transition_timeout_ms`; tiered timeouts 60min/15min for 1b/2) → auto-resolve HITL via fixture golden decisions (unknown gate shape ⇒ `blocked_on_hitl`) → drain to `capture/turn_terminal` event (never trust poll seq) → artifact download → golden checks → capture assertions → **p95 gate check failing the run with code `slo_gate_breach`**. p95 = sorted[ceil(n·0.95)−1]. Outcome codes: `ok, seed_failed, start_failed, transition_timeout, overall_timeout, blocked_on_hitl, no_final_artifact, artifact_not_json, golden_mismatch, assertion_mismatch, download_failed, slo_gate_breach, unexpected_terminal`. Abandoned turns get best-effort `stopTurn` to avoid leaking Temporal workflows/sandbox leases.

Capture assertions (model-independent ground truth): terminal_event, gate_reached per step, no_duplicate_gates, pending_set_count (warn), **hitl_necessity (strict fail)**, all_sets_resolved, tool_call_hygiene (only bound-skill script basenames + known harness tools), no_failed_tool_calls (warn), no_capture_errors (warn).

### 4. Runner: execution modes & report format

CLI entry `index.ts`: `pnpm --filter @avenza/eval run [--skill --scenario --all --repeat --runs-dir --base-url --no-seed --resume <turn_id>]`. Config via env `EVAL_BASE_URL/EVAL_PRINCIPAL_ID/EVAL_WORKSPACE_ID/EVAL_ORIGIN/EVAL_DATABASE_URL`. Service must run with `HARNESS_EVAL_SEED=true` (flag-gated seeding seam at `POST /v1/internal/eval/seeds/{conversationId}`: base64 files + setup_commands into the sandbox; plus skill-catalog seeding from `skills-packages/`). `EVAL_LIVE=true` gates only the vitest live e2e test; the benchmark itself is the CLI against a running HTTP service. Crash-resume: `--resume <turn_id>` skips seed/start, reattaches via status `last_committed_seq` + SSE `after=N`, then re-enters the normal loop (proven live 2026-08-16). Report: `report.json` + `report.md` in runs dir — header `N/M passed`, table of Skill | Scenario | Outcome | Detail | Acceptance ms | Turn ms | live p95 ms; runs filed under `docs/wiki/benchmark/runs/`. Reports must cite CLI invocation, commit sha, run ids.

### 5. Coupling analysis: reusable vs avenza-specific

**Reusable as-is (transport-agnostic):** scenario manifest schema concept (zod), golden checker, capture-assertion *logic* given an event envelope stream, p95/SLO math (`slo.ts` pure), wedge-detection pair (state+iteration), report builder/renderer, outcome-code taxonomy, resume semantics, tier/timeout policy, the whole wiki/wayfinder methodology.

**Coupled to avenza API:** `FetchHarnessClient` (the only driver impl) hits avenza routes `/v1/conversations/{id}/turns`, `/v1/turns/{id}` (+`/pending-set`, `/resolve-pending`, `/stop`, `/artifacts`), presigned artifact download, `/v1/internal/eval/seeds`, header identity stub, SSE envelope format with `occurred_at`, capture-event families, `@avenza/service/eval-support` catalog seeding.

**Driver abstraction: specified, NOT implemented.** Code has only the `HarnessClient` interface (harness-client.ts). The full `HarnessDriver` interface (start/status/pending/resolve/stop/artifacts/download/**openEvents(turnId, afterSeq, signal) → AsyncIterable<{envelope, receivedAt}>**/seedConversation) exists as a design deliverable in `context/research/round4-avenza-benchmark-gaps.md` §5, with planned files (`driver.ts`, `AvenzaHttpDriver`, `drivers/pi.ts`, `--driver pi`). Binding contract for any port: **same state vocabulary + monotonic `last_committed_seq`**, so wedge detection and the turn_terminal drain criterion work unchanged.

### 6. Results: baseline vs run15

Baseline (pre-v4, 12 scripted): 12/12 PASS; acceptance 5–30ms; turns 64–97s; live SSE p95 311–550ms. Post-capability-wave regression: 12/12 still green. Run14: 10/17 (59%). **Official run15 (2026-08-17): 14/17 (82%)** — Tier 1a 12/12 ✅ (parity); Tier 1b 1/4 (AP autonomous PASS 221s; FNOL/EOB/lease produce artifacts + open correct gates but exact golden names/schemas differ — model output-content variance at the autonomy frontier); Tier 2 vendor-onboarding 1/1 ✅. Per-metric deltas (final-report matrix): completion 12/12→14/17; golden fidelity 100% on passing runs; process fidelity strict hitl_necessity; crash-resume proven live; HITL strict; budgets real accounting + honest active time + nudges; cost tracked ($0.07/$0.14 per 1M); context usage accumulated; tool hygiene basename tools; degradation PENDING_EXPIRED + reconciler; artifacts work-root+artifacts-root discovery; parallelism waves ≤8 + subagent fan-out observed. Turn times grew ~64–97s → 109–693s (DeepSeek latency + capability overhead) but inside gates; acceptance stayed 7–17ms; live p95 rose 311–550ms → 575–721ms (still <1000ms gate). 15 live defects found+fixed via the loop.

### 7. ADR digest (docs/wiki/decisions/)

- **0001 — Harness v4 effort**: Run v4 as a benchmark-driven autonomous goal on `benchmark/prototype-v1`, 3 human checkpoints (CP1 spec/map, CP2 first vertical+capability+delta, CP3 final+merge), GitHub issues tracker, wiki as compounding memory, deepseek-v4-flash sole model, pi never a benchmark subject, every PR carries before/after delta.
- **0002 — Thin spine + worker-side plugin tree**: Three layers — deterministic Temporal workflow spine (~600-line guardrail, honestly reported exceeded at ~1160 lines but determinism holds), worker-side plugin/composition tree (HMR lives here), pure planners in-workflow. Decided by Temporal replay determinism: dynamic plugin loading in workflow corrupts state.
- **0003 — dsh borrow/contest/measure**: Borrow goals (CAS revisions), plan mode, feedback log, guards, composition profile/bundle/patch pattern, capability seams; contest everything-is-a-plugin-in-the-loop (dsh's revertible-effect model can't unwind committed effects), HMR-in-workflow, non-durable self-modification, dsh-as-base; measure every borrow via benchmark dimension deltas.
- **0004 — Benchmark-first**: Baseline first (gap list = backlog); Tier 1 = 12 scenarios toward autonomy, Tier 2 = wayfinder-produced novel flow; SLOs become pass/fail p95 gates; 12 metrics enumerated; matrix deepseek × avenza baseline-vs-improved.
- **0005 — Tier decisions (CP1 follow-through)**: Tier 1b = fully minimal prompts (binary autonomy signal vs 1a anchor); Tier 2 = vendor onboarding because it exercises the C10 ingestion path end-to-end. Decided autonomously per user delegation, overridable at CP2/CP3.

### 8. Wayfinder map conventions (wayfinder/README.md)

Destination statement + notes + "Decisions so far" (one line per closed ticket, linking ADR/context pages) + "Not yet specified" (**fog list**) + "Out of scope". Tickets on GitHub issues, labels `wayfinder:{map,research,prototype,grilling,task}`, one ticket per session (research excepted), claim-by-assign, native issue dependencies for blocking. Resolution protocol: (1) resolution comment, (2) close issue, (3) append line to "Decisions so far", (4) write ADR/context page citing benchmark evidence, (5) **graduate fog into fresh tickets** (create-then-wire blocking); out-of-scope items are ruled out rather than resolved.

### 9. Wiki protocol (README.md, log.md, index.md)

Karpathy llm-wiki pattern: README = schema ("read first; every session starts here, ends updating the wiki"). Session protocol: read README + last 20 log entries + index + map → work one ticket → write before ending (log append, index update, ADR per decision with benchmark evidence, wayfinder resolution entry, benchmark run reports) → periodic lint (contradictions, stale claims, orphans, superseded-by marks). `log.md`: append-only `## [YYYY-MM-DD] type | title` + 1–3 sentence body. `index.md`: category sections each linking files with one-line annotations. Conventions: ADRs `NNNN-slug.md` with frontmatter + Context/Decision/Alternatives/Evidence sections; raw sources never edited — summarized into wiki pages; contradictions are bugs logged and fixed via ADR.

**Port recipe**: keep scenarios/goldens/capture-assertions/SLO/wedge/resume/report logic wholesale; implement a `MausBotDriver` behind the documented HarnessDriver interface (state vocabulary + monotonic seq + envelope stream with occurred_at + eval seed endpoint are the four hard requirements); replicate tiers/metrics/gates config verbatim; clone wiki + wayfinder protocols as-is.

---

## B5 — Deterministic workflow spine anatomy

Stack: Fastify HTTP + Temporal Cloud worker in one Node process (`server.ts:36-114`), Postgres (pg, raw SQL), E2B sandboxes, R2 object storage. **No SQLite anywhere; no ORM.**

### 1. The turn workflow — `turns/agent-turn-workflow.ts` (1,430 lines)

The single Temporal workflow `AgentTurnWorkflow(input)` (line 170). ADR 0002 mandates a "thin deterministic spine ≤600 lines" — honestly documented as exceeded (lines 53-64). Determinism rules enforced throughout: no DB/network/wall-clock/random in workflow code; every side effect goes through `proxyActivities<TurnActivities>` groups with per-activity timeouts/retries (lines 50-95): light Postgres ops 30s×3, `callModel` 5min×3, sandbox lifecycle 30s×3, `dispatchSkillTool` 15min×3, `discoverArtifacts` 60s×2.

Execution shape:
- Handlers registered first (replay-safe closure state): `getStatusQuery`, `stopTurnSignal`, `resolvePendingUpdate` (192-208).
- `accepted→running` CAS transition via activity (210); skill binding, GenUI tool prep, capability/guard flags, goal context, plan injection — all activities (229-359).
- Main loop (973-1262): budget check via **pure** `checkBudgets()` called directly in-workflow (991), `callModel` activity (1024), wave-batched tool dispatch via pure `planDispatch()` scheduler (1079), results appended in model call order (1143-1150).
- Terminal path: artifact discovery → unconditional sandbox release → `running→completing` → goal-round record → atomic terminal commit (1272-1420). Every failure branch still reaches a clean terminal commit (comment at 1015-1021).

Deterministic vs activity-side: in-workflow = state machine decisions, budgets, dispatch scheduling, HITL wait bookkeeping, message-array assembly. Activity-side = all Postgres writes, model HTTP, sandbox exec, id minting (`mintId`, because UUIDv7 is nondeterministic).

### 2. Event sourcing + outbox

**Envelope** (`db/event-producer.ts:63-207`): `{schema_version:1, event_id(uuidv7), workspace_id, conversation_id, turn_id, seq, occurred_at, family, kind, item_id?, causation_id?, trace_id?, payload}` — Zod-validated (`HarnessEventSchema`) + secret-scan before commit; >256KiB payloads spill to R2 `payload_ref` with upload-before-commit (113-139). Table `events` PK `(turn_id, seq)` (migration 0001).

**Monotonic seq**: inside the tx, `pg_advisory_xact_lock(hashtextextended(turn_id))` serializes per-turn producers, then `MAX(seq)+1` (151-157). Service-generated only.

**Two outboxes, one pattern**:
- `event_outbox` (SSE fan-out notifications): row inserted in the same tx as the event (181-184); `streaming/sse-publisher.ts:17-27` claims batches every 200ms and pokes an in-process `FanoutHub`. Notification is a latency hint only — Postgres is authority.
- `temporal_command_outbox` (Postgres→Temporal commands): `command_type ∈ {startTurn, stopTurn}` (`migrations/0002`; `turns/temporal-deliver.ts:25-68`). Idempotent enqueue, `FOR UPDATE SKIP LOCKED` claim, crash-reclaim lease, exponential backoff capped 5min, 10 attempts.

**CAS everywhere**: turn rows (`UPDATE ... WHERE state=$from`, `turn-state-machine.ts:90-97`), pending sets (`WHERE status='open' AND pending_set_version=$2`), goals (`revision` bump guarded by re-read + expected revision, `goals/goal-state.ts:208-222`), memory items (`expected_version`), sandbox leases (`fencing_token AND lease_state = ANY(...)`, `sandbox/lease-state-machine.ts:64`).

### 3. Storage seam

- **DB**: no repository interface — direct `pg.Pool` + SQL everywhere; 14 numbered migrations in `apps/service/migrations/` (events/outbox/checkpoints/transcripts; turns; skills; sandbox_leases; artifacts; pending_sets; memory; goals/plans/feedback).
- **ObjectStorage interface** (`storage/object-storage.ts:21-27`): put/get/delete/presignGet/head; sole impl `R2ObjectStorage`.
- **ModelProvider** (`model/provider.ts:14-24`): `call()`, `pricing()`, `providerId`.
- **SandboxProvider** (`sandbox/sandbox-provider.ts:39-46`): acquire/probe/renew/exec/release; sole impl `E2bSandboxProvider`.

### 4. Model-provider seam & streaming into events

`model/openai-compatible-provider.ts`: non-streaming OpenAI-compatible `POST {baseUrl}/chat/completions` (DeepSeek v4 Flash via OpenCode Zen), `ProviderCallError{retryable}` mapped to retry policy in the `callModel` activity. DeepSeek `reasoning_content` must round-trip or endpoint 400s. **No token streaming**: the whole step returns at once; the workflow then emits one coalesced `stream/text_delta` + `stream/message_stop` + `narrative/final` event triple through the `emitEvent` activity.

### 5. SSE / live path

Route `GET /v1/turns/:turn_id/events?after=N` (`http/app.ts:1212-1365`): origin+auth+connection-quota checks, `reply.hijack()` for raw chunked SSE, heartbeat frames, real `res.write()` backpressure with drain-await and 1000-event/1MiB guard. Replay/live handoff (`streaming/handoff.ts:33-80`) is the A/B algorithm: high-water A → replay `(after,A]` from Postgres → subscribe to fanout → high-water B → catch-up `(A,B]` → live drain by seq with gap-refill and `event_id` dedupe. `REPLAY_EXPIRED` when `after < MIN(seq)` or turn fully evicted-but-finalized. Frames carry `id: seq`; `Last-Event-ID` must agree with `after` or 409. `live_lag_ms`/`replay_lag_ms` are eval SLO gates measured in `apps/eval` as `occurred_at` vs receive time.

### 6. HITL pending-set

State machine `open→resolving→resolved | cancelled`, `open→expired|cancelled` (`hitl/pending-set-lifecycle.ts:8-14`). Open = one tx: set row (version 1, `expires_at=now+7d`) + actions + `capture/pending_set_opened` event (65-131). Resolve route = transaction A (`open→resolving` CAS) → synchronous Temporal Update to the workflow's in-memory handler (version + exact action coverage validated) → transaction B (`resolving→resolved` + answers + event) (`hitl/resolve-pending.ts:36-74`). Workflow waits `condition(() => resolved || stopRequested, expiresAt-now)` (615); on timeout it CAS-expires the set, returns to running, and forces terminal outcome `failed/PENDING_EXPIRED` regardless of model claims (1187-1197). Expiry-CAS failure means a resolution is in flight → bounded re-wait (653-698). **Honest gap**: a stuck `resolving` row has no automated reconciler (resolve-pending.ts:32-34).

### 7. Sandbox layer

E2B-only today behind `SandboxProvider`. Lease machinery in Postgres (`sandbox_leases`, fencing tokens, states acquiring/ready/in_use/idle/released/expired/failed), reuse path probe×3, TTL 10min renewed every 4min by an in-workflow keepalive loop using `condition()` timers (76-77, 377-390). Skill scripts run via checksum-verify → stage → exec inside the leased sandbox with a timeout-policy race (`turn-activities.ts:383-431`); auto-pause recovery re-acquires once (919-935). Artifacts discovered from `/workspace/artifacts` pre-release, hashed, R2-uploaded, quarantined. Eval seeding seam `POST /v1/internal/eval/seeds/:conversation_id` (`http/app.ts:1056-1133`): flag-gated `HARNESS_EVAL_SEED=true`, acquires a real sandbox, base64-writes fixtures via E2B files API, runs setup commands, parks lease idle for reuse.

### 8. Portability analysis for a plain-Node single-process host (OpenMausBot)

| Piece | Verdict | Notes |
|---|---|---|
| Event envelope + schema validation + privacy scan | **Portable as-is** | Pure Zod + uuidv7; swap advisory-lock/MAX(seq) for SQLite AUTOINCREMENT/single-writer mutex |
| Per-turn monotonic seq | **Portable as-is** | Single writer makes it trivial |
| Event outbox-as-table → SSE notifier | **Adapt** | Keep table + claim/backoff columns; simple poll (single process doesn't need leases) |
| Command outbox (`startTurn`/`stopTurn`) | **Adapt** | Becomes a plain in-process queue/function call; keep rows for crash-recovery audit if desired |
| Turn state machine + CAS transitions + atomic event-in-same-tx | **Portable as-is** | It's just SQL; SQLite transactions work identically |
| Goal/plan/memory/pending-set CAS modules | **Portable as-is** | All plain pg functions; port SQL dialect |
| Budgets (`checkBudgets`), wave scheduler (`planDispatch`), gate mapping | **Portable as-is** | Already pure functions |
| A/B replay→live handoff, backpressure, REPLAY_EXPIRED | **Portable as-is** | Needs no Temporal |
| Tool loop structure (waves, ordered results, nudges/guards) | **Adapt** | Logic ports; hand-roll per-call deadlines (code already does for scripts) |
| Durable HITL wait | **Temporal-bound** | In-process you get an in-memory promise + DB row; crash mid-wait loses the waiter unless you rebuild "resume pending turns on boot" yourself |
| Workflow replay/determinism, activity retry semantics | **Temporal-bound** | Replaced by ordinary async code; error taxonomy (`retryable` flags) worth keeping as convention |
| Timers (keepalive loop, child-timeout sleep) | **Temporal-bound** | Replace with setInterval/setTimeout; acceptable since mausbot turns are short-lived CLI children |
| Child workflows (subagents) | **Temporal-bound** | Becomes a function call/child process; cumulative budget accounting ports fine |
| Start saga (idempotency ledger + row + outbox in one tx) | **Adapt** | Ledger concept ports directly to SQLite |

**Complexity honesty**: the genuinely hard, high-value parts — envelope discipline, seq monotonicity, CAS-everywhere, commit-before-publish, A/B handoff, HITL two-transaction resolve, budget/nudge hygiene — are all just careful SQL/Node engineering and port cleanly. What Temporal buys here is specifically (a) crash-resume of a mid-turn workflow without a custom resumer, (b) durable timers/waiters, (c) free retries/timeouts. For mausbot's short per-turn CLI model, (b)/(c) shrink dramatically, but (a) is exactly what its "no durability" design lacks — expect to write a small boot-time reconciler ("find turns stuck at running/awaiting_input, decide resume-vs-fail") which avenza gets for free. The 1,430-line workflow file is also a warning: much of its bulk is benchmark-patched prompt plumbing, not orchestration, and would collapse once determinism constraints are removed.

---

## B6 — Capabilities C1–C10 port assessment

Spine primitives referenced: **event log** (`db/event-producer.ts`, turn-scoped WAL PK `(turn_id, seq)`), **outbox** (`temporal/outbox-dispatcher.ts` + `turns/temporal-deliver.ts`), **CAS revisions** (`goals.revision`, `pending_sets.pending_set_version`), **activities** (`turns/turn-activities.ts`), **waves** (`tool-loop/dispatch-scheduler.ts`), **durable waits** (Temporal `condition()`), **child workflows** (`executeChild`).

| # | Capability | Files | Mechanism | Spine deps | LOC (impl) | Port to non-Temporal Node host |
|---|---|---|---|---|---|---|
| 1 | Goal state + continuation | `goals/goal-state.ts`, migrations 0012/0013, routes in `http/app.ts` (L459–719), workflow wiring L336–359, L1358–1400, activities `loadGoalContext`/`recordGoalRound` | `goals`/`goal_rounds` tables are durable truth; round reservation is structural (`UNIQUE(goal_id,round_no)` + `FOR UPDATE`, revision bump per mutation); events ride the causing turn's WAL. Continuation is **not** workflow-internal: any driver POSTs `/v1/goals/:id/rounds`, which runs the start saga then reserves the round; terminal path records outcome + context_summary (final text ≤4000 chars + cost/active-ms) fed into next round's system prompt. Crash-resume = state in Postgres, rounds resumable by any driver. | event log, CAS revision, activities, start saga/outbox | ~900 | **Moderate-hard.** Row/CAS/rounds port cleanly to SQLite transactions, and API-driven continuation fits a driver SPI well; but crash-resume today silently inherits Temporal replay — you must build a store-driven resumable turn state machine yourself. |
| 2 | Plan mode as logged state | `goals/plan-state.ts`, migration 0012, workflow L354–359 + plan_mode branch L499–526, route L814 | Whole-value per-conversation fold (`plans` row, revision++), log-only `narrative/plan_updated` event committed in the calling turn; model-facing `plan_mode` tool (set/clear); active plan injected as a system message each turn start. | event log, activities | ~210 | **Easy.** No Temporal semantics at all — a SQLite row + context injection. |
| 3 | Feedback recording | `recordFeedback` in `goals/goal-state.ts` (L450–512), route L773 | `feedback` row + `capture/feedback_recorded` event, idempotency-keyed; explicitly never read by any context-assembly path (contract A). | event log | ~100 | **Easy.** Insert + event kind; discipline that the store query for context excludes it. |
| 4 | Real budgets | `tool-loop/budgets.ts`, usage parsing in `model/openai-compatible-provider.ts`, pricing activity `getModelPricing`, accumulation in workflow L397–422, L979–1013, L1040–1049, L1156–1182; goal ceilings enforced in rounds route L577–588 | Pure `checkBudgets()` over 4 classes (iterations/active-time/context/cost): soft 80% crossing injects exactly one convergence nudge per class (de-duped via `softNudged` set), hard breach terminates (`timed_out` vs `failed`, QUOTA_EXCEEDED). Usage comes from real chat.completions tokens; cost = tokens × env prices; active time excludes HITL/subagent waits. | activities (pricing), pure fn safe in workflow | ~250 | **Easy.** Easier without Temporal — `Date.now()` free. Mausbot already banks `TaskUsage` from `turn.completed`. |
| 5 | Wave-batched dispatch | `tool-loop/dispatch-scheduler.ts`, `tool-loop/tool-effect-registry.ts`, wave executor workflow L1069–1154 | `planDispatch(nodes)` = DFS cycle rejection + Kahn layering; ≤8 concurrent reads per wave, every write gets a solo wave; results collected into a map and appended in the model's original `tool_calls` order (strict-endpoint 400 fix). Registry maps tool name/input → effect_class + target_key. | none (pure) | ~270 | **Easy.** Zero Temporal coupling; `Promise.all` waves work in any host. |
| 6 | HITL wait timeout + reconciler | `hitl/pending-set-lifecycle.ts` (308), `resolve-pending.ts`, `get-pending-set.ts`, reconciler step in `db/retention-scheduler.ts`, wait/expire logic workflow L568–728, L1187–1197 | Pending-set state machine open→resolving→resolved/expired/cancelled with version CAS; HTTP resolve route CASes open→resolving, then a Temporal **Update** validates version/completeness in-workflow. Wait is `condition(..., expires_at − now)`; on timeout: expire CAS → back to running → forced `failed/PENDING_EXPIRED` terminal; if expire-CAS fails (resolution in flight) re-waits bounded 60s before failing closed. Reconciler resets `resolving` rows older than 60s → open. | CAS versions, activities, durable `condition()`, turn state machine | ~630 total HITL; C6 delta ≈ 200 | **Hard.** The CAS machine + reconciler port fine; the problem is the multi-day durable wait inside an otherwise in-process turn — you need turn suspension + store-resume (same machinery as #1's crash-resume). |
| 7 | Model/storage seams | `model/provider.ts` (44), `model/provider-config.ts`, `model/openai-compatible-provider.ts` (178), `storage/object-storage.ts` (82), `storage/r2-client.ts` | Plain TS interfaces: `ModelProvider.call()/pricing()/providerId` and `ObjectStorage.put/get/delete/presign/head`; env factory; activities take the interface; tests swap fakes. | activities | ~340 | **Easy.** Direct analogue of mausbot's driver SPI; copy nearly verbatim. |
| 8 | Worker-side composition | `capabilities/harness-config.ts` (149), `skills/*` (catalog 140, matching 34, select-skill-for-turn 27, build-skill-tools 63, load-skill-package 123, gate-mapping 41, package-storage 64, execute-skill-script 59), `harness.config.json` | Boot-time zod-validated config (fail-closed on unknown names, missing file = all-on defaults); capability flags gate the model-facing tool list; guards (`repeat-tool-reminder` once-per-turn advisory, `timeout-policy` → dispatch deadline). Skills bind to flows at turn start: `selectSkill` matches message → catalog row → package fetched by sha256 → each script exposed as a basename tool with argparse-derived usage; gated process steps become `request_human_review` tools + mandatory-gate prompt blocks. | activities, ObjectStorage, sandbox exec | ~700 | **Easy-moderate.** Config/flags/guards port directly; skill binding needs storage (R2→local dir) and exec (E2B→workspace cwd) adapters swapped. HMR deliberately deferred upstream — boot-time only. |
| 9 | Subagent orchestration | Workflow `spawn_subagent` branch L750–857, `createChildTurn` activity, queue threading in `temporal-deliver.ts` L44–46; children reuse `AgentTurnWorkflow` via `executeChild` | Tool call mints a child turn row (activity), then `executeChild("AgentTurnWorkflow", ...)` with own turn_id/budgets/events; guarded by ≤2 concurrent children, cumulative child-time budget (default 10 min, refusal nudge when spent), per-child 8-min wall-clock cap via `Promise.race(sleep)`; result = child's `{outcome, final_text}` as the tool message. Correlation is `trace_id` inheritance + `causation_id` on tool_call events — **not** outbox-based. | child workflows, activities, event log | ~110 | **Moderate.** Maps naturally onto "spawn another per-turn CLI child via driver SPI", arguably simpler than Temporal; must hand-thread causation/correlation ids and budget caps; known caveat: classified idempotent_write but a retry re-spawns (no dedupe). |
| 10 | Ingestion | `ingest/ingest-files.ts` (126), route L724, `list_inputs` tool branch L731–748 + `listInputFiles` activity; eval seam `/v1/internal/eval/seeds` L1056 (flag-gated) | Public endpoint: origin+auth+idempotency checked, basename-only paths, base64 decode, byte-sniffed MIME allowlist, EICAR heuristic quarantine, 25 MiB/20-file caps; accepted files written into the conversation's workspace; model discovers files via read-only `list_inputs`. Eval seeding is a separate flag-gated internal endpoint sharing only the sandbox lifecycle. | sandbox lease CAS, activities | ~205 | **Easy.** Sandbox becomes a local workspace dir; validation/quarantine logic copies as-is. |

### borrow / contest / measure verdict (ADR 0003 + fit-evaluation-final)

The final evaluation confirms ADR 0003 with evidence: **borrow the concepts, reimplement natively; contest the everything-is-a-plugin claim; do not run dsh in the benchmark matrix.** Borrowed (each mapped to a benchmark dimension): goal state + round-driver (CAS, phases, continuation) → C1; plan mode as whole-value logged fold → C2; feedback contract A (log-only, never in model context) → C3; guards (repeat-tool reminder, timeout policy) → C8; composition profiles/bundles/patches → C8 boot-time config; capability seams → C7 ModelProvider/ObjectStorage. Contested, with reasons: Cordis-style everything-is-a-plugin-in-the-loop is only sound in a single process where unload hooks revert effects — avenza's effects span Postgres/Temporal/R2 and need compensation, not unload, and workflow replay-determinism forbids dynamic code in the loop; dsh's engine has "explicitly no journaling/resume/checkpointing"; its self-modification is process-memory-only; and dsh-as-base fails on no eval harness, no HITL pending-set product, no SSE, no deterministic benchmark substrate. Measure: every borrowed concept landed with a measurable surface — goals → live crash-resume proof, plan → `plan_updated` stream events, budgets → per-flow cost in goal rounds, guards → reminder events, composition → config-toggle unit + eval regression (12/12 twice). Matrix decision (ADR 0004/0005): dsh excluded from v1; official run15 finished **14/17 PASS** — 12/12 scripted parity with baseline, 1/4 autonomous, 1/1 Tier-2 novel flow — with strict HITL-necessity, real budget/cost accounting, and proven crash-resume.

### Porting takeaways

The heavy Temporal dependencies concentrate in exactly two places: **durable waits** (C6 HITL, sandbox keepalive) and **child workflows** (C9) — everything else (C2–C5, C7, C8, C10) is plain TypeScript over Postgres/S3 and ports easily to SQLite/local-disk + a driver SPI. C1 is moderate: the data model and API-driven continuation transfer directly, but crash-resume requires building what Temporal gave for free — a resumable turn state machine keyed off the store. A single "suspendable turn" abstraction (persist loop state at await points, resume from store) would unlock both C1 crash-resume and C6 long waits at once.
