---
status: accepted
date: 2026-08-20
deciders: port effort (autonomous, per user delegation in GOAL-PROMPT)
---

# ADR 0001 — Port effort shape: benchmark-driven, 3 checkpoints, wiki as memory

## Context
avenza-harness v4 proved a methodology on its own repo: benchmark-first development, durable
goal-driven autonomy, and a wiki/wayfinder memory. OpenMausBot is a product-shaped local-first
harness (chat UI, approval cards, computers, apps) with zero turn durability. The mission is to
port avenza's capability set (C1–C10) and benchmark onto OpenMausBot natively.

## Decision
- Run the port as a benchmark-driven autonomous goal on branch `benchmark/port-v1` of a fork of
  milind-soni/OpenMausBot. NEVER push upstream; only the user merges.
- Three human checkpoints: CP1 (benchmark spec + wayfinder map), CP2 (first vertical passing +
  first capability + measured delta), CP3 (final review + merge decision).
- Wiki-first protocol replicated here: docs/wiki/{README,log,index,decisions,context,benchmark,
  wayfinder}; every session starts by reading it and ends by writing it; ADRs carry benchmark
  evidence; wayfinder tickets live on the fork's GitHub issues with labels `wayfinder:*`.
- Baseline = full 17-scenario suite run against STOCK mausbot through a thin MausBotDriver,
  built before any capability work. Expected near-zero pass rate IS the gap definition.
- Every change carries a before/after delta; failures become work items, never silence.

## Alternatives considered
- Improve avenza further instead — rejected: mausbot is the target product surface; avenza v4 is
  complete per its DONE criteria.
- Rebuild mausbot around Temporal/Postgres like avenza — rejected in ADR 0002.

## Evidence
Pre-goal dossier (docs/wiki/context/research/port-dossier/): 6 deep-read briefs + fit evaluation
showing high fit with one architectural inversion (durability is net-new).
