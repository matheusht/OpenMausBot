# openmausbot-port dossier

Deep-research dossier for porting avenza-harness v4 onto OpenMausBot (2026-08-20).

- `briefs/openmausbot.md` — 3 briefs: spine/architecture · drivers/approvals/tools · state/persistence/long-running
- `briefs/avenza.md` — 3 briefs: benchmark system + ADR digest · deterministic spine anatomy · capabilities C1–C10
- `FIT-EVALUATION.md` — synthesized graft map, difficulty table, driver requirements, risks
- `GOAL-PROMPT.md` — the adapted goal prompt (drop-in replacement for the avenza v4 goal)

Repos: `../OpenMausBot` (upstream clone) · `../avenza-harness-v1` (worktree of avenza
`benchmark/prototype-v1`, the wiki + v4 code source of truth).

Phase 0 of the new goal copies `briefs/` + this evaluation into the target repo's
`docs/wiki/context/research/port-dossier/`.
