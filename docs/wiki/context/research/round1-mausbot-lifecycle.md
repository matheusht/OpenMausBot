# Round 1 — Long-flow lifecycle & strategy (mausbot)

Source: subagent deep-read, 2026-08-20. Companion briefs: round1-mausbot-extraction, round1-mausbot-sqlite.

## 1. Child lifecycle (`procs.ts`, `claude.ts`, `codex.ts`)

**Spawn:** One CLI child per turn, spawned detached in its own process group so `kill(-pid)` reaps the CLI plus its MCP-proxy grandchildren on POSIX; Windows uses `taskkill /T` (`procs.ts:32-37`, `84-110`). A dying child's stdin `error` event is deliberately swallowed — an unlistened async error would crash the whole harness (`procs.ts:39-50`).

**Claude (`claude.ts`):** prompt goes over stdin as one stream-json frame, then `stdin.end()` (`claude.ts:664-667`) — no long-lived stdin dependency. stdout is line-buffered UTF-8 with multibyte-safe chunk decoding (`claude.ts:624-636`); stderr ring buffer capped at 8 KB (`claude.ts:638-642`). **Crash mid-turn:** `child.on("close")` emits `runtime.error` ("claude exited N before result") then `settle(false,"exit_before_result")` (`claude.ts:649-658`). `settle()` is idempotent, closes the permission broker, deletes the 0600 MCP credentials tempdir, removes the thread from `active`, emits `turn.completed` (`claude.ts:516-534`).

**Codex (`codex.ts`):** JSON-RPC over stdio against `app-server`; writes try/catch-wrapped (`codex.ts:202-207`); handshake RPCs have a 60 s timeout (`codex.ts:208-228`). The app-server never exits on its own — `settle()` calls `stop()` explicitly (`codex.ts:240`).

**Hours-long risks:** memory/fd growth bounded per turn (one broker socket + ≤4 MCP children, closed at settle; stderr capped). Real growth: `appendNative` does synchronous `appendFileSync` per protocol message (`native.ts:18-22`) — unbounded file size and sync-I/O latency over a 4 h turn. Torn final NDJSON line after crash is harmless (line parser skips bad lines, `claude.ts:541-547`).

## 2. resumeCursor lifecycle — chain-of-turns is ALREADY viable

- **Set:** driver emits `session.started` → `store.setResumeCursor(botId, instanceId, sessionId, threadId)` persisted per-task (`index.ts:684-687`; `store.ts:854-865`).
- **Guarded:** `engineIsFresh` true when a different instance ran last or cursor map ambiguous; fresh/rewound threads get inline transcript replay instead (`turn-context.ts:29-40,47-68`; `index.ts:1314-1329`). Rewind wipes cursors at dispatch (`index.ts:1602`). Cursor passed only when `resume===true` (`index.ts:1563-1566`). `markTaskDispatched` records `lastInstanceId` (`store.ts:867-875`).
- **Reuse:** consecutive turns on one task with same engine pass `--resume <sessionId>` (claude `claude.ts:389-403`) or `thread/resume` with fresh fallback (codex `codex.ts:456-479`).

**Conclusion:** anything that keeps POSTing follow-up turns to the same task/thread gets native-session continuity for free — exactly the avenza C1 shape. Missing piece: only a durable driver of follow-up turns (precedents: steer-queue drain `index.ts:1098-1119`; routine tick `routines.ts:442-488`).

## 3. Watchdogs vs long flows

`TURN_STALL_MS = max(60s, OMB_TURN_STALL_MS || 20min)` (`index.ts:543`). Semantics: **no events at all**, not "no progress" — any `RuntimeEvent` touches the clock (`index.ts:585-590`; `turn-watchdog.ts:63-66`); an hour-long streaming turn is never touched (`turn-watchdog.ts:8-11`). Stall ⇒ interrupt + error chip + 6 s grace (`index.ts:548-581`). Human-pending exemption: `request.opened` sets `waitingOnHuman`; sweep skips those turns indefinitely (`turn-watchdog.ts:70-75,90`). Absolute ceilings only for rooms: default 5 min, max 1 440 min = 24 h (`config.ts:16-18`; `index.ts:1845-1873`). 1:1 task turns have **no duration ceiling**; ask_bot 4-min ceiling. Approval cards hard-deny at 15 min in both drivers (`claude.ts:217,268-275`; `codex.ts:288-291`), answering questions "use your best judgment".

For avenza-style flows these become workflow-level policies: stall ⇒ heartbeat requirement; approval timeout ⇒ per-workflow budget/auto-approve profile; room ceiling ⇒ per-run wall-clock budget triggering a checkpoint round, not a kill.

## 4. Crash matrix & boot reconciler sweep list

| Event | Survives | Lost / needs sweep |
|---|---|---|
| **Server SIGKILL mid-turn** | bots.json (cursors, tasks, usage, messages), NDJSON tee, CLI's own session files | Children **orphaned**: detached pgroup keeps running and **no PIDs are persisted anywhere** (only `process.pid` for pipe names, `procs.ts:118`) — no orphan sweep exists |
| **CLI crash mid-turn** | Native session on CLI disk; cursor banked at `session.started` (`store.ts:854-865`); transcript | Nothing stranded: close handler emits `runtime.error` + `settle(false,"exit_before_result")` (`claude.ts:649-658`; `codex.ts:437-446`); fold clears busy/activity (`index.ts:933-934`) |
| **Machine sleep/resume** | Everything on disk incl. cursors; CLI session resumable | **No sleep handling.** Timers are wall-clock (`turn-watchdog.ts:39-41,91`): on wake, `now - lastEventAt > stallMs` ⇒ stall-kill though nothing was wrong |

**Boot reconciler must add:** orphan sweep by pgid (requires persisting child pids/pgids — none exist today); stale-busy reset (already done, `store.ts:436-438`); leaked `omb-mcp-*` tmpdirs (removed only in `settle`, `claude.ts:527-531`); torn NDJSON tail (benign); stale `.sock` (handled by unlink-on-create, `claude.ts:222-224`).

## 5. Strategies for a 4 h business flow

**(a) One mega-turn.** Watchdog is *not* inherently hostile: activity-based, any event touches the clock — an hour of streaming is legal. But: any silent >20 min phase = kill; approval cards hard-deny after 15 min; sleep >20 min kills; fatal flaw — **no turn survives a server restart** (`store.ts:427`; routines fail on restart `routines.ts:187-197`). Context growth compounds: each assistant message re-reads the growing session (cache reads billed as input, `claude.ts:605-618`).

**(b) Chain-of-turns, durable goal object (avenza C1).** Continuity already works via resumeCursor (guarded by `engineIsFresh`/`rewound`). Missing piece only: a durable driver of follow-up turns — both precedents exist (steer-queue drain fires follow-up on any `turn.completed`; routine tick dispatches when idle). Goal object persisted like `routines.json` (atomic tmp+rename, `routines.ts:563-568`) survives restarts; crash loses only the in-flight round. Per-round benefits: fresh 20-min silence budget each round; 15-min HITL windows bounded per round; unattended marking persists across rounds while busy (`index.ts:605-627`); usage banked per round as natural budget checkpoints (`store.addTaskUsage`, `store.ts:880-902`). Cost: per-round fixed overhead — CLI spawn + MCP proxies + 0600 mcp-config write (`claude.ts:500-506`) + system prompt rebuild (`index.ts:1568-1597`) + skill selection (`1349-1357`). Transcript replay NOT paid between same-engine rounds (only rewind/engine-switch, capped last-40).

**(c) Hybrid.** Rounds may run long (streaming keeps watchdog fed) but every round ends at a workflow-level budget boundary with state checkpointed to the goal object; budgets replace kills as the round-ender.

## 6. Cost/latency notes

Per-turn fixed costs: argv/env rebuild + `mkdtempSync` config file (`claude.ts:500-506`); codex initialize→thread/start handshake w/ 60 s timeout (`codex.ts:452-494`); persona+computer+composio+skill prompt rebuilt every dispatch (`index.ts:1568-1597`). Usage: claude reports per-invocation `result.usage` incl. cache reads as input; codex banks running thread totals since app-server is fresh per turn; both fold into task tally at `turn.completed` (`index.ts:905-932`). Chained turns multiply fixed overhead (~seconds + tokens per round) but give per-round metering mega-turns lack.

## Recommendation

**(b), shading to (c):** durable goal object driving chained turns via the existing resumeCursor path, rounds allowed to run long while activity streams (hybrid round-length policy). Continuity is built and guarded; restart-survival is the dominant 4 h failure mode and only chaining fixes it; watchdog/HITL semantics map cleanly onto round boundaries. Tradeoffs: per-round spawn/prompt-rebuild overhead (mitigated by prompt caching); goal store becomes critical state needing atomic writes + boot reconciliation alongside orphan-process sweep. Avoid (a) alone: one SIGKILL or sleep forfeits up to 4 h of work.
