---
status: accepted
date: 2026-08-20
deciders: port effort (autonomous continuation authorized by user: "go ahead, fully autonomous long-run")
---

# ADR 0006 — CP1 deferred to autonomous continuation

## Context
The goal prompt makes CP1 (benchmark spec + wayfinder map review) a permission gate. The user
has authorized a fully autonomous long-run with feedback loops. Avenza precedent: CP1 was
likewise deferred to autonomous continuation; its review mechanism (grilling tickets) stayed
open on the tracker rather than being faked.

## Decision
- Benchmark spec (docs/wiki/benchmark/README.md) and wayfinder map (docs/wiki/wayfinder/
  README.md) are charted autonomously now and treated as PROVISIONAL until human review.
- The grilling ticket (HITL gate semantics on approval cards) remains OPEN on the fork's issue
  tracker as the standing human-review mechanism.
- This decision, the spec, and the map are OVERRIDABLE at CP2/CP3 without a new ADR; any work
  built on them must be structured so reversal is cheap (additive modules, thin adapters).
- Checkpoints CP2/CP3 remain real gates: implementation proceeds, but merge/final acceptance
  waits for the user.

## Alternatives considered
- Halt at CP1 — rejected: contradicts explicit user authorization; blocks the long-run.
- Skip documenting the deferral — rejected: wiki is truth of record; silent gate-skipping is
  exactly what the protocol forbids.

## Evidence
User instruction (2026-08-20): "go ahead, fully autonomous long-run for this, feedback loop
too." Avenza ADR 0005 precedent (autonomous tier decisions, overridable at CP2/CP3).
