# Briefs — OpenMausBot (3 subagents, 2026-08-20)

## B1 — Core architecture / spine

Repo: `/Users/matheusvsky/Documents/trab/oslit/harnesses/OpenMausBot` — a local-first, single-user chat harness for AI agent teams. All server code is plain TypeScript run via `node --experimental-strip-types` (no build step in dev), Node ≥24.

### 1. Module map / topology

| Component | Path | Role | Transport |
|---|---|---|---|
| Web app | `src/` (React 19 + Vite, dev port **5199**, `vite.config.ts`) | UI only; "clients hold no transports" (`server/index.ts:1-3`) | HTTP commands + one SSE stream; Vite proxies `/api` → 8799 |
| Harness server | `server/index.ts` (**4007 lines**), binds `127.0.0.1:8799` (`index.ts:96`, `3995`) | The whole spine: routes, registry, bus, folds, store, watchdogs | One `node:http` `createServer` handler (`index.ts:2272`); serves built UI from `STATIC_DIR` when packaged (`index.ts:3969`) |
| Electron shell | `electron/main.mjs` | Desktop wrapper; forks the server as a `utilityProcess` child (`main.mjs:211`), ports 8799/18799/28799 fallback; owns CUA/TCC attribution | IPC to renderer; spawns server |
| Companion sidecar | `companion/src/index.ts` | Phone pairing: `:8810` devices (token+allowlist), `:8811` loopback control, proxies to :8799 unmodified | mDNS/Tailscale advertise |
| Cloudflare worker | `cloudflare/composio-broker/` | OAuth/MCP broker for Composio connectors only | fetch |
| Driver SPI | `server/contracts.ts` (337 lines) | Canonical types + adapter/driver interfaces | — |
| Registry + bus | `server/harness/registry.ts` (196), `server/harness/bus.ts` (63) | configs → live instances; fan-in event tee | in-proc |
| Drivers | `server/drivers/*.ts` incl. `acp/*` (13 registered in `drivers/builtIn.ts`) | One file per engine (claude, codex, gemini, …) spawning CLIs | child procs |

### 2. Turn lifecycle end-to-end

1. **UI send**: `POST /api/bots/:id/messages` (`index.ts:3350`). If bot busy → `queueSteeredMessage` (`server/steer-queue.ts`), returns 202; else `startTurn`.
2. **`startTurn(botId, text, opts)`** (`index.ts:1228`): bot lookup + busy guard 409 (`:1252-1253`); thread/task resolution (`:1254-1260`); instance = `registry.get(bot.modelSelection.instanceId)` (`:1265-1267`); user message persisted `store.appendMessage` (`:1297`); transcript from `store.activePath` last 40 text msgs (`:1302-1306`); resume logic: `rewound` / `engineIsFresh` / `buildTurnContext` (`:1314-1329`, `server/turn-context.ts`); marks activity "working" (`:1342`).
3. **Background dispatch IIFE** (`index.ts:1346-1630`): assembles `integrations` — composio bridge (`:1362`), per-bot workspace cwd (`:1370-1384`), Local VM lease `localVmLease.claim` (`:1411`), VPS provision/reuse (`:1439-1464`), Box cloud provisioning ~90s (`:1468-1506`), peer-agent MCP (`:1533-1538`); builds system prompt (`:1568-1597`); `watchdog.watch(threadId)` (`:1557`); **`await instance.adapter.sendTurn({threadId, text, model, effort, resumeCursor, transcript, system, integrations, cwd})`** (`:1558-1600`); `store.markTaskDispatched` (`:1604`). Catch path releases leases, `watchdog.settle`, appends error chip, drains queue (`:1612-1629`). HTTP response is just 202 — the turn is fire-and-forget.
4. **Driver spawn**: per-turn CLI process. E.g. `claude.ts`: `spawnCli(config.cli, args)` (`claude.ts:510`), session resume via `--resume <sessionId>` from `turn.resumeCursor` (`claude.ts:389`), teardown `killCliTree(child)` (`claude.ts:660`). `server/procs.ts`: POSIX detached process group so `kill(-pid)` reaps the tree; Windows `taskkill /T` (`procs.ts:26-52`, `84-110`); stdin-error swallow to avoid fatal EPIPE (`procs.ts:50`).
5. **Events**: driver emits normalized events → `adapter.onEvent` → `EventBus.attach` stamps `providerInstanceId`, rejects cross-driver events (`bus.ts:18-31`) → `publish` (`bus.ts:33-53`): appends redacted NDJSON canonical log `EVENTS_DIR/<threadId>.ndjson` (`bus.ts:38-42`), then synchronously calls every subscriber.
6. **Server-side fold** (`index.ts:664-973`, the "ingestion worker, miniature"): broadcasts `{kind:"runtime", event}` to SSE (`:671`); maps events → transcript messages (`pushMessage`→`store.appendMessage`, `:678-734`); auto-approve on `request.opened` (`:735-805`); permission answers via `answerRequest` (`:424-490`); `turn.completed` settles usage/idle/notification (`:910-962`); repeat-detector subscriber (`:1009-1028`); delegation drain (`:1078-1085`); steer-queue drain (`~:1087-1110`).
7. **UI**: single `GET /api/events` SSE (`index.ts:2588-2634`) with `Last-Event-ID`/`?since=` cursor replay from an in-memory ring buffer (`broadcast`, `index.ts:391-408`; hello/resumed handshake `:2607-2621`); consumed by `new EventSource("/api/events")` at `src/state/store.tsx:1343`.

### 3. Registry & bus semantics

- **Registry** (`registry.ts:49-196`): built once at boot from config map (`index.ts:112-113`); unknown driver or `decodeConfig`/`create` failure becomes an **unavailable ShadowInstance**, never a startup failure (`registry.ts:60-106`). Rebuilt live on settings change via `reloadProviders()` (`index.ts:2149-2155`) — which **kills all in-flight turns** then force-settles any bot still marked busy. `disposeAll` at SIGINT/SIGTERM (`index.ts:3999-4006`).
- **Bus**: pure in-memory synchronous fan-out; no backpressure, no persistence beyond the appendFileSync NDJSON tee, no replay API (SSE replay is the separate UI ring buffer, bounded by `REPLAY_MAX`, keyed to a per-boot `STREAM_ID`).

### 4. Crash / restart behavior (critical finding)

- **Turns are not durable.** On load, `Store` resets every bot: "busy never survives a restart — no turn does either" — `busy=false`, `activity="idle"` persisted back (`store.ts:427-443`). A crash mid-turn silently loses the turn; only the already-appended transcript and the NDJSON event log remain.
- What *does* survive: bots/groups/threads JSON under `DATA_DIR` (atomic writes), **resume cursors** (`task.resumeCursors`, set at `index.ts:686`), decision audit log, delegation queue (drained at boot, `index.ts:1035` comment), steer queue.
- Lost on restart: pending approval cards' in-flight map `askMessageByRequest` (fail-closed fallback exists, `index.ts:470-488`), watchdogs, VM leases, SSE cursors (client must re-hydrate).
- Orphan risk: on SIGKILL/crash, spawned CLI children are not reaped on next boot (no orphan sweep found); graceful shutdown relies on `disposeAll()`.

### 5. Driver SPI (`server/contracts.ts`)

- **Types**: `DriverKind/InstanceId/ThreadId/TurnId`; `ProviderError` codes (`missing_cli`, `invalid_credentials`, …) `:14-30`; `EFFORT_LEVELS` `:34`; `ModelSelection {instanceId, model, effort?}` `:45-50`; opaque `InstanceConfig` envelope (unknown drivers round-trip as shadows) `:56-65`.
- **`RuntimeEvent`** (~12-member union over base with `eventId/provider/threadId/turnId/itemId/requestId/raw`) `:72-127`: `session.started/exited`, `turn.started/completed{ok,cost,usage}`, `item.started/updated/completed`, `content.delta`, `request.opened/resolved{behavior,source}`, `thread.token-usage.updated`, `runtime.error{setup?}`.
- **`ProviderAdapter`** `:197-244`: `capabilities{sessionModelSwitch, agentsMcp, computerMcp, composioMcp, phoneMcp, images, effortLevels, localComputerMcp}`; `sendTurn(SendTurnInput)→{turnId}`; `interruptTurn(threadId, turnId?)`; `respondToRequest(threadId, requestId, {behavior,message})→RequestOutcome` (`"allowed-once"|"rejected"|"answered"|"unavailable"` — fail-closed); `hasSession(threadId)`; `stopAll()`; `onEvent(listener)→unsub`.
- **`SendTurnInput`** `:142-191`: text/model/effort/`resumeCursor`(opaque native continuation)/transcript/system/`integrations{composio,computer,localComputer,agents,phone,dweb}`/cwd.
- **`ProviderInstance`** `:296-309`: identity, `models`, `refreshModels?`, `adapter`, `snapshot()`, `generateText?`, `dispose()`. **`ProviderDriver`** `:316-331`: `metadata`, `install?`, `decodeConfig` (throw→shadow), `defaultConfig()`, `models`, `create(DriverCreateInput)→Promise<ProviderInstance>` — "`create` owns ALL per-instance state; two create calls share nothing."

### 6. Concurrency model

- **One turn per bot** (busy flag, 409 on overlap); **N bots concurrently**, each turn its own CLI child process ("agentcal per-turn-process model", `contracts.ts:139-141`). No global concurrency cap.
- Room turns: single speaker per room (`groupSpeakers`/`busyBotId`), absolute ceiling via `scheduleRoomTurnTimeout` (`room-turn-timeout.ts:5-10`, used `index.ts:1864`), stall completion via `RoomTurnStallRegistry` (`index.ts:544`,`561`).
- **Stall watchdog** (`turn-watchdog.ts`): activity-based; default 20 min silence (`TURN_STALL_MS`, `index.ts:543`), 60 s sweep, human-pending exempt; onStall interrupts + error chip + 6 s ownership grace (`index.ts:548-581`). ask_bot has a 4-min ceiling. Local VM is single-lease (`localVmLease`, `index.ts:632`).

### 7. Commands & tests

`package.json`: `dev` (vite 5199), `dev:server`, `lint` (oxlint), `build`/`typecheck` (tsc -b ×2 + vite), `test` = `scripts/test-floor.mjs` (vitest wrapper asserting ≥1070 registered tests) + broker/updater/packaged-server suites. Vitest config in `vite.config.ts`: globs `server/**/*.test.ts` etc., `fileParallelism:false` (suite spawns fake CLIs + real server), 20 s timeouts. ~28k lines in `server/*.ts`; biggest: `index.ts` 4007, `computer-proxy.ts` 1073, `store.ts` 1039, `container-computer.ts` 917, `vps-computer.ts` 808, `webhooks.ts` 633, `routines.ts` 569.

### Key risks for hosting a durable workflow engine here

1. **No durability**: turns are in-memory fire-and-forget; crash = lost work (busy reset at `store.ts:437`). Avenza's event-sourced spine/outbox has no counterpart — you'd bolt persistence alongside `store.ts` JSON files.
2. **Single-process, localhost-only design**: binds 127.0.0.1, assumes desktop Electron context, spawns local CLIs; multi-tenant/hosted use needs auth, sandboxing, and process isolation rework.
3. **`reloadProviders()` kills all in-flight turns** (`index.ts:2149`) — unacceptable for long-running workflows without a lease/drain protocol.
4. **Bus has no replay/backpressure**; slow SSE clients just drop frames (write-fail → delete client). Outbox-style guaranteed delivery must be added.
5. **Monolith pressure**: `index.ts` is a 4k-line god-module mixing routing, folding, policy; extraction seams exist (harness/, contracts.ts are clean ports from an Effect-based upstream) and are the natural graft points.
6. Watchdog semantics (20-min stall kill, room absolute timeout) would need to become workflow-level policies rather than turn-level kills.

---

## B2 — Agent execution layer (drivers, approvals, tools)

### 1. Canonical event taxonomy

**Defined in `server/contracts.ts:84-127`** (`RuntimeEvent`), base at `contracts.ts:72-82` (`eventId`, `provider`, `providerInstanceId`, `threadId`, `turnId`, `itemId`, `requestId`, plus `raw: {source, payload}` escape hatch carrying the native protocol message). ~12 kinds (comment says it's a subset of an upstream 49-member union):

`session.started|exited`, `turn.started|completed` (ok, stopReason, cost, **usage**{input,output}), `item.started/updated/completed` (itemType `tool|reasoning|assistant_text`), `content.delta` (streamKind `assistant_text|reasoning_text`), `request.opened` (requestType `permission|question`, tool, summary, choices, approvalScope), `request.resolved` (behavior allow/deny/answer; source `user|auto|timeout|system|unavailable|peer`), `thread.token-usage.updated`, `runtime.error` (with `setup:true` marker).

Fan-in: `server/harness/bus.ts:14-63` — every adapter's listener merges into one bus, stamps `providerInstanceId`, tees a redacted per-thread NDJSON log (0600), then dispatches to subscribers (SSE + the server-side folder in `server/index.ts:664-1000`). `RequestOutcome` (`allowed-once|rejected|answered|unavailable`) at `contracts.ts:135`.

### 2. Drivers (one per protocol)

| Driver | Protocol | Normalization highlights |
|---|---|---|
| `drivers/claude.ts` | stream-JSON both directions over stdin/stdout, per-turn process, `--resume <sessionId>` as resumeCursor | `system/init`→session.started (:552), `stream_event/content_block_delta`→content.delta (:557-571), `assistant`/`user` frames→items (:572-604), `result`→turn.completed with usage (:605-620) |
| `drivers/codex.ts` | app-server JSON-RPC (NDJSON stdio) | notifications `item/agentMessage/delta`, `item/started|completed`, `thread/tokenUsage/updated`, `turn/completed` settle (:305-394); handshake initialize→thread/start-or-resume→turn/start (:452-508) |
| `drivers/grok.ts` | xAI chat-completions SSE | transcript-replay driver (`SendTurnInput.transcript`); no tools, no asks (`respondToRequest` → `"unavailable"` :207) |
| `drivers/acp/core.ts` | ACP = JSON-RPC 2.0 stdio; one core + per-harness `AcpSupport` (grok/gemini/kimi/droid/cursor/opencode-go/qwen/hermes in `acp/*.ts`) | `session/update` chunks/tool_calls→deltas/items (:413-459); **no turn/completed — the `session/prompt` RPC result is the settle** (:633-651); history replay double-gated via `_meta.isReplay` (:418) |
| `drivers/boxagent.ts` | cloud-computer agent REST: `POST /boxes/{id}/prompt`, poll `/events` + `/prompts/{promptId}`, `/interrupt` | liberal shape-tolerance, text growth diffing (:149-155), 30-min ceiling (:216) |

### 3. Approval / HITL flow

```
CLI permission gate
  └─ spawns permission-proxy.ts (MCP stdio; tools approve/ask_user)
       └─ {t:"ask"} over per-thread unix socket (path: claude.ts:196-209)
            └─ createPermissionBroker (claude.ts:211-309): pending map +
               15-min timer (timeoutMs :217) → emits request.opened (:469-479)
                    └─ EventBus → fold (index.ts:735-876):
                         autoVerdict? (auto-approve.ts:106-161)
                           guards (destructive/sensitive regex :13-31) OUTRANK grants
                           grants: alwaysAllow keyed `Bash:git` style (approvalKey :61-71),
                                   or bot.autoApprove mode
                           unattended turns block ALL auto-approval (:134-146;
                             marked at index.ts:605-627)
                           local-computer scope never delegated (:147-156)
                         ├─ yes → adapter.respondToRequest(allow) THEN chip +
                         │        decision row (index.ts:757-786); failure → card fallback
                         └─ no  → options card appended to store (:819-848, allowKey
                                  precomputed server-side), activity "waiting-on-you",
                                  desktop notify, decision-log card-shown (:855-866)
User answers POST /api/bots/:id/respond | /api/threads/:id/respond (index.ts:3413-3459)
  ├─ peer-card intercept resolvePeerComms (peer-approval.ts:145-158)
  └─ answerRequest (index.ts:424-490) → adapter.respondToRequest
       └─ broker.answer → {t:"answer"} over socket → proxy returns MCP result to CLI
```

- **Timeouts: yes, uniformly 15 minutes.** Claude `claude.ts:217,268-274`; Codex `codex.ts:288-291`; ACP `acp/core.ts:396-399`; peer cards `peer-approval.ts:64,118-126`. Unanswered permission → **deny** with "skip this action" note; unanswered question → answered "use your best judgment"; source `"timeout"`.
- Turn end/interrupt settles asks with source `"system"` (`claude.ts:296-300`; `closeOpenApprovals` index.ts:496-506). Server restart kills pendings; stale peer cards dismissed at boot (`peer-approval.ts:188-206`). `unavailable` outcome is fail-closed and settles the card visibly (index.ts:470-488).
- Audit: `decision-log.ts` — append-only `decisions.ndjson`, 4MB rotation, rows `{decision: auto-approved|card-shown|user-approved|user-denied, source, rule, unattended}` (:29-51), written only after the provider actually took the answer.
- The stall watchdog exempts threads waiting on a human (index.ts:585-590).

### 4. Steering mid-turn

Not live injection — **queue-and-drain**. `steer-queue.ts`: a send to a busy bot persists immediately with `queued:true` (:44-51); memory-only queue; on ANY `turn.completed` the drain fires ONE follow-up turn whose prompt is queued texts joined by newlines (:58-86, wired at index.ts:1098-1120). Deliberately survives Stop ("stop-then-steer"). `member-turn.ts` is only model-selection propagation for room members; `turn-context.ts:47-68` builds inline-replay preambles for rewound/fresh-engine joins.

### 5. Tool surfaces

One integration envelope, `SendTurnInput.integrations` (`contracts.ts:153-189`): `composio` (500+ apps via a local stdio bridge that relays to Composio MCP through the harness, `composio.ts:164-224`; prompt teaches SEARCH/SCHEMAS/MULTI_EXECUTE), `computer` (cloud box REST→MCP, `computer-proxy.ts` — one round trip per step, act+settle+capture inline image, `computer_batch`), `localComputer` (Cua Driver MCP direct: host `local-computer.ts`, Docker Local VM `container-computer.ts`, BYO VPS `vps-computer.ts`), `agents` (peer comms proxy, depth-capped `MAX_COMMS_DEPTH=1` index.ts:135), `phone`, `dweb`.

Exposure per driver: Claude mounts them as MCP servers in a 0600 `--mcp-config` file with `--allowedTools` pre-allow (`claude.ts:412-506`); Codex via `-c mcp_servers.*` argv with env-var indirection (`codex.ts:57-73`); ACP via `session/new`/`session/load` mcpServers (`acp/core.ts:230-268`). Capability booleans (`contracts.ts:199-228`) gate what's offered. `mcp-bridge.ts` is a transparent stdio pipe adding only a who-is-driving refusal gate and a liveness watchdog. `skill-library.ts` bundles manifest-driven skills injected as system-prompt instructions (index.ts:1349-1357); `attachments.ts` saves pasted images to disk (10MB cap) and passes paths.

### 6. Model/engine selection

`ModelSelection {instanceId, model, effort}` is pure data (`contracts.ts:45-50`); each bot stores one. Default fleet = one instance per driver (`config.ts:307-333`); picker = `GET /api/instances` → `registry.describe()` with PATH rescan so newly installed CLIs appear (index.ts:3615-3622; `harness/registry.ts:121-189`, incl. `cliCandidates` dropdown). Custom binary: `PATCH /api/instances/:id {cli}` → `withInstanceCli` (`config.ts:246-280`) → `reloadProviders()` (index.ts:2151-2183) disposes and rebuilds the whole fleet, killing in-flight turns. `PUT /api/config` hot-reloads the fleet on key change but skips profile/tts/vps/rooms (index.ts:3763-3769); credentials are injected per-driver only (`injectedEnvironment` config.ts:294-300). Local sidecar hosts (oMLX/Ollama/EXO/LM Studio/Unsloth) appear under Custom as `host::model` ids (`local-inject.ts:19-45`); ACP pins models via `session/set_config_option` with confirmation-or-fail (`acp/core.ts:583-605`).

### 7. Voice/TTS & observation (brief)

`tts/` — ElevenLabs/Cartesia behind `/api/tts/prepare|voices|speak`; server-side utterance splitting (`speech-text.ts`), 500-char billable-synthesis cap (index.ts:3804). `computer-observation.ts` — `ObservationCoordinator`: hash-deduped screenshot sends, crop regions, structured browser targets; `scripts/bench-observation.ts` benchmarks suppression offline.

### 8. Resemblance map to avenza mechanisms

| avenza mechanism | OpenMausBot counterpart |
|---|---|
| Goal continuation | Partial. Per-instance-per-task `resumeCursor` (set on `session.started` index.ts:684-688; consumed index.ts:1566), `engineIsFresh`/`buildTurnContext` rejoin replays, steer-queue auto-continuation. No first-class goal object/budget lifecycle. |
| Plan mode | None. No plan/act phase split anywhere in drivers or fold. |
| Feedback capture | Strong analogues: steer-queue (mid-turn user words), `ask_user` question cards, decision-log provenance rows, RepeatDetector (index.ts:535). |
| Budgets | Accounting only: `turn.completed.usage`, `addTaskUsage` (index.ts:928-932), claude `cost`. **No spend caps/enforcement.** Time budgets exist: 20-min stall watchdog (index.ts:543), 4-min ask_bot ceiling (index.ts:217), 30-min box ceiling, room turn timeouts. |
| Batched tool dispatch | No harness-side wave batching of tool calls. Nearest: `computer_batch` (many UI actions, one round trip) and steer-queue joining messages into one turn. |
| HITL wait timeouts | Present but blunt: uniform 15-min broker timers, fail-closed deny/answer, no state machine, no reconciler, dies on restart. |

---

## B3 — State / persistence / long-running

### 1. Persistence inventory

Root: `~/.openmausbot` (`OMB_DATA_DIR` override; legacy `~/.opengrokbot` renamed on boot) — `server/config.ts:115-131`.

| What | Where | Format | Guarantees |
|---|---|---|---|
| Bot records, tasks, resume cursors, usage | `bots.json` (`store.ts:307`) | Whole-array JSON, rewritten every mutation | `writeFileAtomic` = tmp+fsync+rename (`atomic.ts:10-38`). **No CAS/versioning** — last-writer-wins |
| Rooms/channels | `groups.json` (`store.ts:308`) | Same | Same |
| Transcripts | `messages.db` (`message-db.ts:20`) | SQLite (node:sqlite), WAL, `synchronous=NORMAL`; `messages(thread_id,id,…,json)` + `thread_state(active_leaf_id)` | Append = `BEGIN IMMEDIATE` insert+leaf-update commit (`message-db.ts:137-148`); patches are bare UPDATEs. Legacy per-thread `messages-<id>.json` imported lazily once, renamed `.imported` (`message-db.ts:91-128`) |
| Routine defs + run receipts | `routines.json` (`routines.ts:563-568`) | versioned JSON, whole-file `writeFileSync`+rename (**no fsync**) | Runs capped 2,000 |
| Webhook triggers, delivery receipts, attempts | `webhooks.json` (`webhooks.ts:625-632`) | versioned JSON, atomic, 0600; SHA-256 secret hash only | Idempotency via persisted `endpointId:deliveryId` receipts; caps 2,000 |
| Queued bot⇄bot handoffs | `delegations.json` (`delegations.ts:47-57`) | map sourceThread→items, atomic 0600 | Reloaded + drained at boot (`index.ts:1735-1740`) |
| Permission audit trail | `decisions.ndjson` (`decision-log.ts:53-99`) | append-only NDJSON, per-dir serialized write queue, 4 MB rotate to `.1`, redacted, fire-and-forget | Torn lines skipped on read |
| Runtime/native protocol tees | `events/<tid>.ndjson`, `native/<tid>.ndjson` (`harness/bus.ts:33-45`) | append-only NDJSON, redacted, 0600 | Debug/inspector only (`thread-events.ts` tail-reads them) |
| Config/secrets | `config.json` (`config.ts:203-235`) | zod-validated merge-patch, atomic 0600 | Env vars override file for credentials (`config.ts:133-158`) |
| Bot memory/files | `workspaces/<botId>/MEMORY.md` + `memory/*.md` (`workspace.ts:16-22`) | plain markdown; first 200 lines/24 KB into system prompt | — |

**Restart replay:** no turn survives a process restart (`index.ts:1732`; `busy/activity` force-reset `store.ts:432-438`). Threads reload lazily row-by-row into an in-memory cache (`store.ts:615-632`); the visible conversation is the `parentId` tree path root→`activeLeafId` (`store.ts:643-653`). Model context is rebuilt as *text*: last 40 settled text turns of the active branch for transcript-replay drivers, or an inline "[conversation so far:]" preamble for rewound/fresh engines (`index.ts:1300-1329`, `turn-context.ts:42-68`). Provider-native continuation uses per-task/per-instance `resumeCursors` guarded by `lastInstanceId` (`engineIsFresh`, `turn-context.ts:29-40`). SSE has an in-memory 500-frame replay buffer whose cursor is invalidated across boots via per-run `STREAM_ID` (`index.ts:362-389`).

### 2. Thread/session & team model

- **Branching:** edits fork the message tree; `rewound` flag drops cursors and forces fresh-session + inline replay (`index.ts:3395-3410`). E2E contract in `branching.test.ts`.
- **Tasks:** a bot owns many `TaskRecord`s, each its own thread, cursors, pinned cwd, banked usage (`store.ts:147-175`); switching copies cursors.
- **Rooms:** shared thread, `defaultResponder` (member/everyone/mentions), bulletin injected as shared system prompt, longest-name @mention resolution (`store.ts:329-392`).
- **Multi-agent:** two primitives only — sync `ask_bot` (4-min ceiling) and async `delegate_bot`: persisted queue, ≤4 items/source-thread, depth cap 1 makes A→B→C structurally impossible (`delegations.ts:24-33,96`); drained on `turn.completed` and at boot; optional human approval gate with 15-min timeout→deny (`peer-approval.ts:64`). Visibility via `comms-visibility.ts`: every exchange mirrored into a persistent bot⇄bot DM channel plus chips in both threads. Bots reference each other by `botId` resolved through `list_bots` tool + roster prompts.
- **Chief of staff:** single elected bot (store-enforced, `store.ts:834-852`); roster (≤40) interpolated into its system prompt each turn (`chief-of-staff.ts:26-62`).
- **team-manifest/team-library:** import/export *provisioning* only — zod-validated `openmaus.team` v1/v2 files and a remote GitHub catalog (`team-manifest.ts`, `team-library.ts`); no runtime orchestration semantics.

### 3. Long-running execution

- **Routines** (`routines.ts`): 10 s tick (`:404`); `once`/`daily` wall-clock schedules; >12 h late ⇒ `missed` (`:105,423-428`); `durationMinutes` clamped **15–240 min** (`:158`); statuses queued/running/waiting/completed/failed/cancelled/missed; receipts capture output (2 KB), cost, denials via bus events (`handleRuntimeEvent :494-517`). On boot, any running/waiting run is marked **failed** — "restarted while this routine was running" (`:187-198`). Webhook deliveries enqueue into the *same* manager so busy-bot ordering/task creation/VM routing are shared (`enqueueWebhook :324-357`).
- **Webhooks** (`webhooks.ts` + `webhook-ingress.ts`): localhost HTTP ingress, bearer-or-path secret (SHA-256, timing-safe), delivery-id idempotency, 10 req/min rate limit, **max 3 concurrent unfinished runs per hook** (`:143`), payload fenced as `[UNTRUSTED WEBHOOK EVENT DATA]` inside the prompt (`:304-332`).
- **Unattended** (`index.ts:605-627`, no dedicated file): in-memory `Map<botId,ts>`, 30-min TTL refreshed on read, set for webhook/inherited turns, cleared the moment a human types. Effect: `unattended-block` overrides always-allow grants for destructive-looking tools (`auto-approve.ts:134-142`).
- **Bounds:** room turn timeout 5 min default, 1–1440 min range (`config.ts:16-18`); `TurnWatchdog` kills turns with no events for `stallMs` (human-wait exempt, `turn-watchdog.ts:87-95`); `RepeatDetector` only *observes* loops — it explicitly cannot cut calls off (`repeat-detector.ts:1-6`); `LocalVmLease` 30-min renewable fence on the shared VM (`local-vm-lease.ts`); `LocalVmIdleTimer` suspends the Local VM after 8 h idle (`index.ts:637-654`).
- **Multi-hour autonomous flow today: effectively none.** The longest nominal ceiling is the 24 h room timeout / 4 h routine duration, but nothing resumes: process death fails every run, and there is no durable plan/goal object that outlives a turn.

### 4. Config/secrets

Write-only secrets: API returns configured-or-not booleans; hashes only for webhooks. Desktop shell injects OS-keychain secrets as env at spawn; **env beats file** in `loadConfig`; `syncCredentialEnv` keeps `process.env` in step post-save (`config.ts:160-180`); spawned CLIs get secrets stripped except the one consuming driver (`injectedEnvironment`/`stripWorkspaceCredentialEnv`, `config.ts:187-300`). No file hot-reload — credential writes rebuild the provider registry (`index.ts:2185`). Redaction (`redact.ts`): content-shaped regexes (sk-/ghp_/AKIA/JWT/PEM/key=value) scrub bot-authored stored messages (`store.ts:183-204`), both tees, and the decision log.

### 5. Notify & audit

`notify.ts`: pure policy — kinds approval/question/done/routine-failed/takeover, 140-char summary, per-bot toggle honored, delivery decoupled (SSE frame now, APNs later); **not persisted**. `decision-log.ts`: fleet-wide append-only NDJSON of *why* each tool call was allowed/denied/carded (rule, source, `unattended` flag), serialized queue, 4 MB×2 retention; deliberately excludes peer-approval cards.

### 6. Gaps mapped to avenza capabilities

| avenza capability | Status in OpenMausBot |
|---|---|
| Durable goal state across turns/restarts | **Absent.** Only provider session cursors + transcripts persist; in-flight turns, steer queues (`steer-queue.ts:9-14`), unattended marks, approvals all die with the process; routine runs fail on boot |
| Cost/token accounting | **Partial.** Per-task `TaskUsage{input,output,costUsd,turns}` banked from `turn.completed` (`store.ts:880-902`), UI chips (`src/lib/usage.ts`); **no budgets, thresholds, or enforcement** |
| Feedback capture outside model context | **None.** Everything persisted in a thread is replayable model context; reactions/decision-log/notifications are display-only, never re-entered |
| Wave/batched tool dispatch | **None.** Only `computer_batch` (multiple UI actions inside one tool call, `computer-proxy.ts:597`); no parallel tool-call waves |
| Subagent orchestration w/ correlation ids | **Weak.** Delegations have stable ack ids + depth; webhook runs correlate `deliveryId→runId→threadId`; but max depth 1, ≤4 fan-out, no child-turn trees, no subagent lifecycle |
| Deterministic replay/event sourcing | **None.** Replay is lossy prompt-text reconstruction (last 40 turns / preambles); NDJSON logs are debug tails; SQLite stores folded messages, not events; no state-machine rebuild |
| CAS/transactions across stores | **None.** Atomic rename per file, single SQLite txn per message, but bots.json/messages.db/routines.json writes are independent — no compare-and-swap, no cross-store txn |

**Porting verdict shape:** OpenMausBot gives avenza solid primitives to build on — atomic file replace, WAL SQLite with real transactions, append-only NDJSON discipline, persisted idempotent job queues (webhooks/delegations), and receipt-style run records — but every long-running concept is bounded to a single process lifetime and reconstructed by prompt text, so goal durability, budgeting, and deterministic replay would be net-new layers.
