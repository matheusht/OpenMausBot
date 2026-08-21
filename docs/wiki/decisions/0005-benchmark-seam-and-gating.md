---
status: accepted
date: 2026-08-20
deciders: port effort (evidence: round2-avenza-contracts + round2-mausbot-packaging briefs)
---

# ADR 0005 — Benchmark seam: MausBotDriver behind avenza's HarnessDriver contract, internal routes gated

## Context
avenza's eval runner is transport-agnostic except for one HTTP client. Its specified-but-
unimplemented `HarnessDriver` interface defines the binding contract: same state vocabulary +
monotonic `last_committed_seq` + envelope stream with `occurred_at` + seed endpoint. On the
mausbot side, new internal endpoints must not ship enabled in packaged desktop apps.

## Decision
1. **MausBotDriver implements avenza's HarnessDriver verbatim**:
   `startTurn/turnStatus/pendingSet/resolvePending/stopTurn/listArtifacts/downloadArtifactBytes/
   openEvents(turnId, afterSeq)→AsyncIterable<{envelope, receivedAt}>/seedConversation`.
   Scenarios, goldens, capture assertions, SLO p95 math, wedge detection, resume semantics and
   report builder port wholesale from avenza's apps/eval; only the driver differs.
2. **Server-side contract**: turn status exposes avenza's TurnStatus shape (state vocabulary per
   ADR 0003, current_stage/current_iteration for wedge detection, last_committed_seq for
   resume); SSE frames carry `id: <seq>` with canonical envelope JSON; a flag-gated eval seed
   endpoint writes fixtures into the bot workspace.
3. **Gating** (three tiers, all inherited or copied): loopback+origin guard applies to
   everything; internal APIs sit under `/api/internal/*` behind the per-boot bearer token
   (`authorizedComms`); eval seeding additionally requires an env flag that electron/main.mjs
   NEVER sets — packaged apps physically cannot enable it.
4. **Quality gates every PR keeps green**: typecheck; 3-OS test floor ≥1070 (adding tests is
   free); oxlint anti-slop rules on new files; check:electron untouched; packaged-server smoke
   (dependency-free boot); no new runtime deps without esbuild-bundle justification; new data
   files under DATA_DIR/EVENTS_DIR via ensureDirs, atomic writes, 0600.

## Alternatives considered
- Write a mausbot-native benchmark from scratch — rejected: avenza's runner is the measurement
  instrument whose numbers we compare against (run15 reference line); a different instrument
  breaks comparability.
- Expose eval endpoints publicly — rejected: local-first security posture.

## Evidence
round2-avenza-contracts.md §1/§8/§9 (interface, DTOs, wire format, manifest schema);
round2-mausbot-packaging.md §5 (gating tiers), §3–4 (test floor + CI gates).
