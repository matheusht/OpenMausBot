---
status: proposed (confirm at CP1: verify OpenCode Zen serves deepseek-v4-flash)
date: 2026-08-20
deciders: port effort (evidence: round2-mausbot-deepseek brief)
---

# ADR 0004 — deepseek-v4-flash rides the opencode-go ACP driver

## Context
The benchmark's primary model is deepseek-v4-flash (comparability with avenza run15). In
mausbot, drivers delegate the whole agent loop to CLIs: tool execution, MCP mounts, and
permission asks live inside the CLI process. A raw chat-completions driver would lose the
entire tool/approval/computer surface — the exact capabilities under benchmark.

## Decision
deepseek-v4-flash is served by **OpenCode Zen's OpenAI-compatible endpoint through the existing
`opencodeGo` ACP driver** (`opencode acp`):
- Path A (0 LOC): if Zen's Go catalog lists deepseek-v4-flash it already appears in the model
  picker (`opencode-go.ts:11-70` live catalog fetch); selection pins via
  `session/set_config_option {configId:"model"}` with hard verification.
- Path B (~3–10 LOC fallback): add one `LOCAL_HOSTS` entry for Zen so
  `zen::deepseek-v4-flash` flows through the existing provider-inject writer
  (`ensureOpenCodeInjectModel`, `opencode-go.ts:90-148`).
Full surface inherited from ACP core: agents/composio/computer MCP mounts, `session/request_
permission` approval cards, per-turn model pinning, cancel/resume.

Known limitation (accepted): ACP drivers report usage indicator-only
(`thread.token-usage.updated`; `turn.completed.usage` empty, cost null — `core.ts:340`). Budget
accounting banks from the token-usage fallback; avenza-grade exactness degraded and documented
in benchmark reports.

## Alternatives considered
- New native ACP support file (~120–150 LOC) — kept as path C only if Zen refuses the model id.
- Raw chat.completions driver (grok.ts clone, ~230 LOC) — rejected: zero tools, zero approvals.
- Custom-engine wrapper binary via Settings→Engines — rejected: must reimplement a full coding
  agent (tool exec + permission broker + stream-JSON protocol), 1000s LOC, strictly dominated.

## Evidence
round2-mausbot-deepseek.md §3 (opencode-go mechanics + inject writer proof), §5 (capability
flags), §6 (usage accounting per driver), §7 (recommendation matrix).
