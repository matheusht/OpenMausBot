# Index

## Decisions
- decisions/0001-port-effort-and-checkpoints.md — benchmark-driven port, 3 checkpoints, wiki as memory (accepted)
- decisions/0002-spine-on-sqlite.md — events.db on node:sqlite WAL+FULL; no Temporal/Postgres/E2B/R2 (accepted)
- decisions/0003-suspendable-turns-chain-of-rounds.md — durable goal object drives chained turns; engine extracted first (accepted)
- decisions/0004-deepseek-via-opencode-go.md — primary model rides opencodeGo ACP; usage accounting caveat (proposed → CP1)
- decisions/0005-benchmark-seam-and-gating.md — MausBotDriver = avenza HarnessDriver contract; /api/internal gating (accepted)

## Context
- context/research/port-dossier/FIT-EVALUATION.md — graft map: high fit, one inversion (durability net-new)
- context/research/port-dossier/briefs/openmausbot.md — pre-goal mausbot briefs (spine/drivers/state)
- context/research/port-dossier/briefs/avenza.md — pre-goal avenza briefs (benchmark/spine/C1–C10)
- context/research/port-dossier/GOAL-PROMPT.md — the goal being executed

## Research rounds
- context/research/round1-mausbot-lifecycle.md — long-flow strategies; crash matrix; reconciler sweep list
- context/research/round1-mausbot-extraction.md — index.ts structural map; server/engine/ layout; PR-1 plan
- context/research/round1-mausbot-sqlite.md — node:sqlite capabilities verified; events.db DDL sketch
- context/research/round2-mausbot-packaging.md — electron embedding; bundling; test floor; gating tiers; PR checklist
- context/research/round2-mausbot-deepseek.md — driver registry; ACP mechanics; recommendation matrix
- context/research/round2-avenza-contracts.md — porting contract catalog (interfaces, kinds, DDL, DTOs)

## Benchmark
- (empty — spec lands at CP1)

## Wayfinder
- (map charted at Phase 2)
