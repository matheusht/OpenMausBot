# Round 1 — Extracting a turn engine from `server/index.ts` (mausbot)

Source: subagent deep-read, 2026-08-20.

## 1. Structural map of `server/index.ts` (4007 lines)

| Region | Lines | Contents |
|---|---|---|
| Imports | 1–95 | all module imports |
| Boot wiring | 96–135 | consts (96–108); `ensureDirs`/`cfg`/`registry`/`bus` singletons (**110–117**); `COMMS_TOKEN`, `authorizedComms` (119–131); `MAX_COMMS_DEPTH` (135) |
| Integration builders | 136–190 | `agentsIntegration` (144–157), `phoneIntegration` (159–165), `connectedAppsIntegration` (167–174), `computerControl` + `controlIntegration` (180–190) |
| `askBotAndWait` | 192–225 | sync ask_bot half; 4-min ceiling (217) |
| Store boot + wire shapes | 227–299 | `defaultSelection` (228–238), `store` (240), `wireTask`/`wireBot`/`publicBot` (251–263), `store.onChange → broadcast` (271–299) |
| Message paging helpers | 301–349 | pure given `store` |
| SSE fan-out infra | 351–408 | `sseClients` (360), `STREAM_ID`/`lastSeq`/`replayBuffer` (372–375), `cursorSeq` (382–389), `broadcast()` (391–408) |
| **Fold pipeline** | 410–973 | state maps (416–417); `answerRequest` (424–490); `closeOpenApprovals` (496–506); `lastReply` (513); `notify` (517–521); `groupSpeakers` (525); `turnUsage` (530); `repeats` (535); **watchdog wiring 537–590**; unattended marks 592–627; Local VM lease/idle 628–662; **main fold subscriber 664–973** (`session.started`→cursor 684–688, items 689–734, auto-approve/cards 735–875, resolved 877–891, errors 893–904, usage 905–909, `turn.completed` fold 910–971) |
| Delegation/steer drains | 975–1120 | delegationWatch (980), finalizeDelegationWatch (985–1001), repeat-detector subscriber (1009–1028), delegation drain (1078–1085), steer-queue drain (1098–1119) |
| Screen pollers | 1122–1225 | `screenPollers` map, start/poke/stop/finalScreenFrame |
| **`startTurn`** | **1227–1631** | guards (1251–1263), instance/model resolve (1265–1290), transcript/context (1300–1329), system prompt assembly (1331–1338, 1568–1597), busy flip (1342), integrations/computer routing (1346–1525), `watchdog.watch` (1557), `adapter.sendTurn` (1558–1600), rewind spend + `markTaskDispatched` (1601–1604), catch path (1612–1629) |
| Routines/webhooks wiring | 1633–1690 | `RoutineManager` deps object (1636–1659), `WebhookManager` (1665–1674), ingress (1676–1690) |
| Group (room) turn engine | 1693–1960 | groupQueues (1699), commsBus/approvalBus (1716–1721), stale-card dismissal (1723–1729) + delegation drain (1731–1740), `runGroupMemberTurn` (1742–1920, room ceiling 1845–1873), `startGroupTurn` (1922–1960) |
| Connector resumes | 1962–2056 | pending map, dispatchConnectorResume, drain subscriber (2054–2056) |
| CLI probe/config status | 2058–2147 | |
| **Registry/bus re-wiring** | **2149–2183** | `reloadProviders()`: bus.detachAll→registry.disposeAll/load→bus.attach→busy-settle sweep→drainQueuedSends |
| HTTP plumbing | 2190–2271 | json/readBody, loopback guard |
| **HTTP handler + routes** | 2272–3993 | internal comms 2287–2507; routines 2508–2544; webhooks 2545–2585; **SSE `/api/events` 2588–2634**; bots/pages 2636–2699; attachments 2700–2754; search 2755–2788; export 2789–2830; groups/teams 2831–3064; bot CRUD/memory/cards/respond/interrupt 3065–3481; tasks 3482–3534; local-computer 3535–3577; health 3578; inspector 3582–3600; decisions 3601–3613; instances/CLI 3614–3689; config 3690–3777; voice 3778–3820; connectors 3821–3887; box computer 3888–3965; static SPA 3967–3986 |
| Listen + signals | 3995–4007 | shutdown: idle timer, watchdog, routines, ingress, `registry.disposeAll()` |

## 2. Closure state per seam

Module-level mutable singletons live in index.ts: `cfg`, `registry`, `bus`, `store`, `watchdog`, `roomStallCompletions`, `repeats`, `turnUsage`, `lastReply`, `groupSpeakers`, SSE state (360–375), `screenPollers`, `unattendedBots`, VM lease set (632–636), `activeVpsThreads`, `groupQueues`, `delegationWatch`, connector maps, `computerControl`, `routines`, `webhooks`.

- **Clean (pure functions of inputs):** message paging (301–349), wire shapes (244–263), `json`/`readBody` (2190–2232), `cursorSeq`/`wants` (378–389), `buildTurnContext`/`engineIsFresh` (already extracted, `turn-context.ts`).
- **Tangled (mutate shared module state):**
  - `startTurn` (1227–1631) touches ~20 closures; writes module state (`localVmActiveThread` 1414, `activeVpsThreads` 1443/1458, `markUnattended` 1256).
  - The fold (664–973) reads/writes store, registry, routines, watchdog, repeats, turnUsage, lastReply, both id maps, groupSpeakers, screen pollers, delegation watch, decision log — most tangled seam; extract last, behind an event-log interface.
  - `reloadProviders` (2149–2183) coordinates bus+registry+lease+pollers+drains — stays an index.ts adapter orchestrating engine handles.

## 3. Extraction patterns already proven in-repo

- **Constructor-injected class + options-deps object:** `RoutineManager` (`routines.ts:85-102`) takes `{emit, botState, createTask, startTurn, interruptTurn}` callbacks; wired at `index.ts:1636-1660`. Same for `WebhookManager` (1665–1674) and `TurnWatchdog` (`turn-watchdog.ts:20-26`, injectable `now` + `onStall`). **This is the pattern the engine must follow.**
- **Class with post-construction attach:** `EventBus` (`harness/bus.ts:14-31`).
- **Constructor-injected drivers:** `ProviderRegistry(BUILT_IN_DRIVERS)` then `load(configs)` (`harness/registry.ts:56,60`).
- **Dependency-as-parameter free functions:** `appendDecision(DATA_DIR, row)` (`decision-log.ts`; call sites `index.ts:459,770,804,855`); `drainSteeredMessages(store, run)` (`steer-queue.ts:58`).

No module singletons beyond these; nothing reaches back into index.ts.

## 4. Circular-dependency risks & test import style

**Nothing imports `server/index.ts`.** All integration tests black-box it by spawning the file as a child process against a temp home (`index.test.ts:200`, `branching.test.ts:100`, `steer-queue.test.ts:219`, `comms.test.ts:154`, `unattended.test.ts:101`, `vps-routing.test.ts:202`, `decision-log-wiring.test.ts:131`; fake CLIs in `server/testing/fake-*.ts`; SSE helper `testing/sse.ts`; ports `testing/ports.ts`). Rule: **engine modules must never import index.ts** — they receive `store`/`bus`/`registry`/`broadcast` via constructor; `config.ts` imports are fine (leaf). Avoid new module-level mutable maps like `peer-approval.ts`'s pending map — pass state through the instance.

## 5. Proposed layout: `server/engine/`

| File | Responsibility | Injected deps | Exports | LOC |
|---|---|---|---|---|
| `event-log.ts` | Per-turn monotonic seq; commit-before-publish buffer; replay-from-seq query (generalizes `index.ts:372-408` semantics to turn events) | none (pure class; optional `persistDir`) | `TurnEventLog` (`append`, `commit`, `since(seq)`, `subscribe`) | ~120 |
| `goals.ts` | Durable goal/round records; round-end recording; next-round prompt synthesis; JSON persistence tmp+rename (copy `routines.ts:563-568`) | store-like saver, `emit` | `GoalManager` (`createGoal`, `recordRound`, `nextRound`, `onTurnCompleted`) | ~150 |
| `budgets.ts` | Pure policy: wall-clock/token/turn budgets per goal+round → `{allow, reason}`; replaces kill-semantics with round-boundary checks | none | `evaluateBudget`, `Budget` types | ~80 |
| `waves.ts` | Fan-out N member turns, one per bot, serialized per group (promise-chain pattern of `groupQueues`, `index.ts:1941-1959`) | `dispatch: (req)=>Promise` | `WaveDispatcher.dispatch(wave)` | ~80 |
| `hitl.ts` | Bounded HITL wait: request.opened/resolved → promise with timeout; drives `watchdog.setWaitingOnHuman` (`turn-watchdog.ts:70-75`) | `bus`, `now?` | `HitlWaiter.wait(threadId, requestId, timeoutMs)` | ~90 |
| `turn-engine.ts` | Orchestrator: moved `startTurn` (1227–1631) + screen pollers (1122–1225) + unattended marks (605–627) + `turnUsage`/`lastReply`/`groupSpeakers` lifecycle; emits through `TurnEventLog` | `{store, registry, bus, cfg, broadcast, integrations:{agents,phone,composio,control}, skills, now?}` | `TurnEngine` (`start(req)`, `interrupt(threadId)`, `respond(...)`, `reload()`) | **≤600** (≈405 startTurn + ≈105 pollers + ≈25 unattended + glue) |

**Moves vs stays:** move 605–627, 1122–1225, 1227–1631 (+ maps 513/525/530/535). Stay as thin adapters in index.ts: boot wiring (110–117), `store.onChange→broadcast` (271–299), SSE infra+endpoint (351–408, 2588–2634), fold subscriber (664–973 — later PR shrinks it by subscribing to engine's committed log), drains (975–1120), routines/webhooks wiring (1633–1690), group engine (1693–1960), `reloadProviders` (2149–2183, delegating to `engine.reload()`), HTTP routes (2272–3993), signals (3999–4007).

## 6. Minimal first PR (behavior-preserving, testable)

**PR-1: "Move turn dispatch into `server/engine/turn-engine.ts`".**
1. Create `server/engine/turn-engine.ts` exporting `class TurnEngine`, constructor takes deps object, `start()` is the verbatim body of `startTurn` (1227–1631) with closures replaced by `this.deps.*` — zero logic changes.
2. Move screen pollers (1122–1225) and unattended helpers (605–627) into the same file (narrow surfaces: `pokeScreenPoller`, `finalScreenFrame`, `stopScreenPoller`, `isUnattended` — expose as methods).
3. In index.ts construct `const engine = new TurnEngine({...})` after line 242; replace moved code with one-line delegating shims keeping old names/signatures so all eight `startTurn` call sites (218, 1066, 1109, 1649, 2023, 3364, 3396) and fold references stay untouched.
4. No capability changes: same events, chips, ordering (registration order of bus subscribers is load-bearing — comment at 600–604 — PR-1 must not reorder subscribers).

**Verification:** `pnpm typecheck` + existing black-box suites: `pnpm vitest run server/index.test.ts server/branching.test.ts server/steer-queue.test.ts server/comms.test.ts server/unattended.test.ts server/routines.test.ts`. Follow-up PRs add `event-log.ts` (unit-tested standalone), `goals.ts`, `budgets.ts`, `hitl.ts`, `waves.ts` without touching index.ts again.
