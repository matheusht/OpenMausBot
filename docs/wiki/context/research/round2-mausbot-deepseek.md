# Round 2 — deepseek-v4-flash wiring paths (mausbot)

Source: subagent deep-read, 2026-08-20. Key insight: mausbot delegates the whole agent loop (tool execution, approvals) to CLIs — a raw chat-completions driver loses the entire tool/approval/computer surface.

## 1. Driver registry

`server/drivers/builtIn.ts:18-32` — `BUILT_IN_DRIVERS`: 13 drivers: GrokDriver (raw xAI chat.completions), 8 ACP drivers (grokAgent, geminiAgent, kimiAgent, droidAgent, cursorAgent, opencodeGo, qwenAgent, hermesAgent), ClaudeDriver, CodexDriver, AntigravityDriver, BoxAgentDriver. "Adding a provider is one file + one-line registration" verified (`README.md:292`, `CONTRIBUTING.md:65`).

## 2. ACP core mechanics

`server/drivers/acp/core.ts` = generic JSON-RPC-2.0-over-stdio runtime; each harness an `AcpSupport` (`core.ts:53-125`).
- Spawn: `spawnCli(config.cli, support.spawnArgs(...))` (`core.ts:287`); binary overridable per-instance (`decodeAcpConfig`, `core.ts:145-154`).
- Tools/MCP: `session/new {cwd, mcpServers}` mounts agents/composio/computer as stdio MCP servers (`acpMcpServers`, `core.ts:230-268`) — every ACP driver gets the full integration surface free.
- Permissions: server→client `session/request_permission` → canonical `request.opened` (`core.ts:345-411`), answered fail-closed; 15-min timeout denies (`core.ts:396-399`). This IS the ask mechanism.
- Model pinning: `selectModel {configId}` → `session/set_config_option` with post-condition verification (`core.ts:583-605`), or `configureSession` hook (`session/set_model` for droid/grok/cursor/hermes).
- Usage: prompt result carries usage from root or `_meta` (`core.ts:637-647`; comment names opencode 1.18.18 root usage).

## 3. opencode-go — can deepseek-v4-flash ride it? YES

- Spawns **`opencode`** argv `["acp"]` (`opencode-go.ts:210,:224`); credential env exactly `OPENCODE_API_KEY` (`:225`).
- OpenCode supports custom OpenAI-compatible providers via config: `ensureOpenCodeInjectModel` (`opencode-go.ts:90-148`) upserts `~/.config/opencode/opencode.json` with `{npm:"@ai-sdk/openai-compatible", options:{baseURL, apiKey}, models:{...}}` — in-repo proof the CLI accepts arbitrary chat-completions base URLs + keys.
- **Gap**: that writer only fires for local-inject ids — host ∈ `LOCAL_HOSTS` (localhost sidecars oMLX/Ollama/EXO/LM Studio/Unsloth, `local-inject.ts:19-27,:47-55`). Remote hosts not in set.
- Catalog: live fetch of `https://opencode.ai/zen/go/v1/models`, ids normalized to `opencode-go/<id>` appended as custom rows (`opencode-go.ts:11-70`). **If Zen serves deepseek-v4-flash it already appears in the picker with zero code**; selection pins via `session/set_config_option {configId:"model"}` with hard verification; non-inject ids pass through unchanged (`opencode-go.ts:227`). Auth rides stored Zen login/OPENCODE_API_KEY.
- If Zen's Go catalog lacks it but API serves it: add one LOCAL_HOSTS entry `{id:"zen", baseUrl:"https://opencode.ai/zen/v1", apiKeyEnv:"OPENCODE_API_KEY"}` (~3 LOC) so `zen::deepseek-v4-flash` flows through the existing writer. Mid-session switch works.

## 4. Custom-engine wrapper path (Settings→Engines) — dominated

`PATCH /api/instances/:id {cli}` → `withInstanceCli` (`config.ts:246-280`); spawnCli splits string into command+args. A claude-stream-JSON wrapper would have to act as the agent itself: emit system/init, stream assistant/tool_use frames, execute every tool (bash/edit/MCP servers from --mcp-config), serve the `mcp__ogb__approve` permission tool (`claude.ts:461-493`), emit result frame with usage/cost (`claude.ts:605-619`) — a full coding agent (1000s LOC) + hand-rolled approval broker. Versus an ACP support file at 113–262 LOC that inherits tools/approvals/MCP/resume from createAcpDriver.

## 5. Capability flags

- claude (`claude.ts:700-709`): everything on incl. images + effort levels.
- codex (`codex.ts:542-550`): same minus localComputerMcp.
- ACP all (`core.ts:698-706`): agentsMcp/computerMcp/composioMcp true, images unless opted out, localComputerMcp unless fullAuto, sessionModelSwitch unsupported (per-turn pin instead).
- None-set drivers: registry coerces false (`registry.ts:169-177`). Hard gates: no computer mounting ("this model engine cannot use the Local VM", `index.ts:1401-1404`); no peer-agent tools (`index.ts:1533-1539`); composer hides image paste/effort. Approvals aren't flag-gated but raw HTTP drivers never emit request.opened — GrokDriver sets only sessionModelSwitch and never reads turn.integrations ⇒ zero tools, zero approval cards.

## 6. Token usage accounting

Authoritative: `turn.completed.usage` (`contracts.ts:95-99`); fallback last `thread.token-usage.updated` (`index.ts:905-927`).
- Real turn.completed.usage: claude (incl. cache tokens + total_cost_usd), codex, antigravity.
- Indicator-only (banked via fallback): all 8 ACP drivers — thread.token-usage.updated from prompt result, but turn.completed carries cost:null and no usage (`core.ts:340`); grok API.
- Zeros: boxagent.
**Budget implication:** on the opencode-go path, budgets must bank usage from the token-usage fallback (indicator-only) or read the prompt-result root usage — avenza-grade exactness is degraded; document as known limitation.

## 7. Recommendation matrix

| Path | Effort | Tools | Approvals | Usage | Mid-session switch | Risk |
|---|---|---|---|---|---|---|
| A. Pick `opencode-go/deepseek-v4-flash` if Zen Go catalog lists it | **0 LOC** | full | full | token counts via result root | yes | catalog-dependent |
| B. Add `zen` LOCAL_HOSTS entry → existing inject writer | ~3–10 LOC | full | full | indicator-only | yes | tiny |
| C. New native ACP driver file (clone hermes/qwen shape) | ~120–150 LOC + registration | full | full | indicator-only | yes | duplicates B |
| D. Raw chat.completions driver (grok.ts clone) | ~230 LOC | none | none | indicator-only | yes | loses entire surface |
| E. Custom-engine wrapper binary | 1000s LOC | only reimplemented | only reimplemented | manual | manual | highest |

**Cheapest honest path: A, fallback B.** Both ride existing opencodeGo engine — `opencode acp` gives full surface while the model is served by OpenCode Zen's OpenAI-compatible endpoint, exactly how avenza reached deepseek-v4-flash. Only if Zen refuses the model id does C become necessary; D/E strictly dominated.
