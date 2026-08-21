# Round 2 — Avenza porting contract catalog

Source: subagent extraction from avenza-harness-v1 (branch benchmark/prototype-v1), 2026-08-20. This is the contract a porter must replicate.

## 1. HarnessDriver interface (proposed, avenza round4 §5)

```ts
export interface HarnessDriver {
  readonly name: string;
  startTurn(conversationId, message, idempotencyKey): Promise<StartTurnResult>;
  turnStatus(turnId): Promise<TurnStatus>;          // same state vocab + monotonic last_committed_seq
  pendingSet(turnId): Promise<PendingSetDetail | null>;
  resolvePending(turnId, pendingSetVersion, resolutions): Promise<{ status: string }>;
  stopTurn(turnId, reason): Promise<unknown>;
  listArtifacts(turnId): Promise<ArtifactSummary[]>;
  downloadArtifactBytes(artifact): Promise<Buffer>;
  openEvents(turnId, afterSeq, signal): Promise<AsyncIterable<{ envelope: EventEnvelope; receivedAt: number }>>;
  seedConversation(conversationId, request): Promise<SeedResult>;
}
```

Binding contract = state vocabulary + monotonic seq. SSE parsing moves into driver's openEvents; lag bookkeeping stays in runner.

## 2. HarnessEventSchema (zod)

EnvelopeBase (`packages/schemas/src/events/envelope-base.ts:11-21`):
```ts
{ schema_version: z.literal(1), event_id: Uuidv7Schema,
  workspace_id/conversation_id/turn_id: Uuidv7Schema,
  seq: int.positive.safe(), occurred_at: Rfc3339UtcTimestampSchema,
  causation_id?: Uuidv7Schema, trace_id?: W3cTraceIdSchema }
```
HarnessEventSchema = union(Stream, Capture, Narrative); each variant = EnvelopeBase.extend({family: literal, kind: literal, item_id?, payload}).strict().

**All kinds (closed registry, 24 total):**
- stream: text_delta, reasoning_summary_delta, tool_input_delta (item_id required), message_stop, context_usage
- capture: turn_state_changed, turn_terminal, tool_call_started/completed (item_id=tool_call_id), pending_set_opened/resolved (item_id=pending_set_id), artifact_state_changed (item_id=artifact_id), error, goal_state_changed (item_id=goal_id), goal_round_terminal (item_id=turn_id), feedback_recorded (item_id=feedback_id)
- narrative: plan, phase, chip, reflection, status, genui_render, final, plan_updated (all item_id required)

Producer contract: CommitEventInput {workspace_id, conversation_id, turn_id, family, kind, item_id?, causation_id?, trace_id?, payload}; CommitEventResult {ok:true,event_id,seq}|{ok:false,violations[]}; seq/event_id service-generated; >256KiB payload must spill or fail closed; MAX(seq)+1 allocation under per-turn lock.

## 3. Budgets (`tool-loop/budgets.ts`)

```ts
BudgetLimits { maxIterations; maxActiveMs; contextReserveFraction; maxCostUsd }
DEFAULT_BUDGET_LIMITS = { maxIterations: 60, maxActiveMs: 15*60*1000, contextReserveFraction: 0.2, maxCostUsd: 5 }
SOFT_THRESHOLD_FRACTION = 0.8
BudgetUsage { iterations; activeMs; contextTokensUsed; contextWindowTokens; costUsd }
BudgetClass = "iterations"|"active_time"|"context"|"cost"
BudgetHardBreach { class; outcome: "timed_out"|"failed" }
BudgetCheckResult { softCrossed: BudgetClass[]; hard: BudgetHardBreach|null }
checkBudgets(usage, limits?): soft = fraction ≥ 0.8 (context vs usable window (1-reserve)×window);
hard: iterations/active_time ≥1 → timed_out; context over usable → failed; cost ≥1 → failed
```

## 4. Waves (`tool-loop/dispatch-scheduler.ts`)

```ts
EffectClass = "read_only"|"idempotent_write"|"non_idempotent_write"
CallNode { id; effect_class; dependencies: string[] }
DispatchDecision = {id, kind:"rejected", reason:"dependency_cycle"} | {id, kind:"run", wave:number}
MAX_CONCURRENT_READS = 8
planDispatch(nodes): DFS cycle rejection wholesale; ≤8 concurrent reads/wave; writes isolated
(one write per wave); reads depending on a write wait strictly later wave.
```

## 5. Pending-set lifecycle (`hitl/pending-set-lifecycle.ts`)

```ts
PendingSetStatus = "open"|"resolving"|"resolved"|"expired"|"cancelled"
LEGAL_PENDING_SET_TRANSITIONS = {
  open: ["resolving","expired","cancelled"], resolving: ["resolved","cancelled"],
  resolved: [], expired: [], cancelled: [] }
PendingActionInput { kind:"question"|"form"|"decision"; prompt; answerSchema; required;
  priority:"normal"|"high"; proposedEffect?; proposedEffectHash?; confidence?; threshold?;
  requiredFields?; dataQualityFlags?; provenance? }
OpenPendingSetInput { workspaceId, conversationId, turnId, actions, expiresInDays }
PendingSetHandle { pending_set_id, pending_set_version, actions:[{action_id}], expires_at }
openPendingSet: insert set version=1 'open' + actions + capture/pending_set_opened in one tx
transitionToResolving CAS SQL:
  UPDATE pending_sets SET status='resolving', updated_at=now()
   WHERE pending_set_id=$1 AND status='open' AND pending_set_version=$2
All transitions return CasResult {ok, reason?}; terminal close writes answers +
capture/pending_set_resolved {outcome: "resolved"|"expired"|"cancelled"}
```

## 6. Goals DDL + API

Migration 0012 (verbatim columns):
```sql
goals(goal_id PK, conversation_id, workspace_id, objective,
      state DEFAULT 'active' CHECK IN ('active','paused','blocked','complete'),
      revision DEFAULT 1, round_count DEFAULT 0, blocked_reason, context_summary,
      created_at, updated_at)  -- idx (conversation_id, workspace_id)
goal_rounds(round_id PK, goal_id FK goals, turn_id, round_no,
      outcome CHECK IN ('in_progress','succeeded','failed','stopped','cancelled','timed_out'),
      error jsonb, started_at, completed_at, UNIQUE(goal_id, round_no))
plans(conversation_id PK, workspace_id,
      mode DEFAULT 'inactive' CHECK IN ('active','inactive'), plan_text,
      revision DEFAULT 0, updated_at)
feedback(feedback_id PK, turn_id, workspace_id,
      kind CHECK IN ('remark','rating'), rating CHECK NULL OR 1..5,
      content, author_principal_id, created_at)
```
Migration 0013 adds: FKs goal_rounds.turn_id→turns, feedback.turn_id→turns; goals columns cost_used_usd numeric(12,6) DEFAULT 0, total_active_ms bigint DEFAULT 0, max_active_ms bigint, max_cost_usd numeric(12,6).

API signatures (goal-state.ts): GoalState = active|paused|blocked|complete; createGoal(pool,{goal_id,conversation_id,workspace_id,objective}); getGoal/getGoalByConversation; startGoalRound(pool,{goal_id,workspace_id,conversation_id,turn_id,maxRounds}) → {kind:"started",round_no,turn_id}|not_found|not_active|round_limit|duplicate_round (reserves via UNIQUE(goal_id,round_no), bumps revision, commits goal_state_changed); recordGoalRound({...,outcome,error?,contextSummary,costUsd?,activeMs?}) → commits goal_round_terminal + goal_state_changed, accumulates cost/active_ms; completeGoal; recordFeedback({feedback_id,turn_id,workspace_id,kind,rating?,content,author_principal_id}) — row + feedback_recorded event, NEVER enters model context.

## 7. Turn state machine

```ts
TURN_STATES = ["accepted","running","awaiting_input","completing","succeeded","failed","stopped","cancelled","timed_out"]
TERMINAL_OUTCOMES = ["succeeded","failed","stopped","cancelled","timed_out"]
LEGAL_TURN_TRANSITIONS = {
  accepted: ["running","cancelled"],
  running: ["awaiting_input","completing","failed","stopped","cancelled","timed_out"],
  awaiting_input: ["running","failed","stopped","cancelled","timed_out"],
  completing: ["succeeded","failed","stopped","cancelled","timed_out"],
  succeeded: [], failed: [], stopped: [], cancelled: [], timed_out: [] }
createTurn inserts row state 'accepted';
transitionTurnState: CAS UPDATE turns SET state=$to WHERE turn_id AND state=$from
  + atomic capture/turn_state_changed {from,to} same tx;
commitTerminalTransition: one tx = CAS row + turn_state_changed(from→outcome)
  + exactly-one turn_terminal({outcome, error?}) (error required on failed/timed_out)
```

## 8. Eval runner contract bits (what MausBotDriver must satisfy)

HarnessClient routes today: POST /v1/conversations/{id}/turns (Idempotency-Key header, expect 202); GET /v1/turns/{id}; GET /v1/turns/{id}/pending-set (404→null); POST /v1/turns/{id}/resolve-pending {pending_set_version, resolutions}; POST /v1/turns/{id}/stop; artifacts list/download (presigned); POST /v1/internal/eval/seeds/{conversationId} → {provider_sandbox_id, lease_id}.

DTOs: StartTurnResult {accepted, turn_id, state, status}; **TurnStatus {turn_id, run_id|null, state, current_stage, current_iteration, last_committed_seq, pending_set_id|null, updated_at}**; PendingSetDetail {pending_set_id, pending_set_version, status, expires_at, actions[]}; ArtifactSummary {artifact_id, logical_name, display_name, media_type, size_bytes, status, created_at}; SeedRequest {files:[{path, content_base64}], setup_commands?}; Resolution {action_id, answer}.

Runner semantics: wedge detection compares status.state/current_iteration; HITL trigger when state==="awaiting_input" || pending_set_id; TERMINAL_STATES = succeeded|failed|stopped|timed_out|cancelled; expected terminal "succeeded"; resume uses status.last_committed_seq as afterSeq; drain criterion = seeing capture/turn_terminal event (never poll seq). SSE wire: `id: <seq>\nevent: harness\ndata: <canonical event JSON>\n\n`, heartbeats `: heartbeat`. Capture assertions: turn_terminal outcome match; tool_call_started hygiene vs skill scripts + non-skill set {render_ui, memory, request_human_review, stop_turn, plan_mode, spawn_subagent, list_inputs}; failed tool calls warn; capture/error warn; gate_reached/no_duplicate_gates/pending_set_count/hitl_necessity/all_sets_resolved from observed pending sets.

## 9. Scenario manifest zod top-level

ScenarioDefinitionSchema: skill_slug; scenario enum[scenario-happy, scenario-escalation-heavy, scenario-hard-block, scenario-autonomous]; prompt; fixture_dir; run_dir; final_artifact; final_artifact_path; artifact_is_json bool; golden GoldenCheck[] min1; gates GateExpectation[] min1; max_pending_sets; slo_gates? SloGate; tier enum["1a","1b","2"]; timeout_ms; transition_timeout_ms; extra_seed_files[{path, source_path}]; setup_commands string[] max10.

GoldenCheck {path dot-path into artifact JSON, op eq|approx|gt|gte|lt|lte, value number, tolerance default 0.005}. GateExpectation {step_id, has_golden_decisions, expected_decision_count}. SloGate {acceptance_ms?, turn_ms?, resume_post_ms?, live_lag_ms?, replay_lag_ms?} strict — p95 breach ⇒ fail slo_gate_breach. Decisions from fixture dir decisions.json; gates with has_golden_decisions auto-resolved inline by runner.
