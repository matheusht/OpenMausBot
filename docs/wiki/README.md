# Wiki

The wiki is the memory of this port effort ("if you don't log it, it didn't happen").
Adapted from avenza-harness v4 conventions (see context/research/port-dossier/).

## Session protocol
1. Read this README, the last ~20 entries of log.md, index.md, and wayfinder/ map state.
2. Claim ONE frontier ticket before working (map lands at Phase 2 / CP1).
3. Work. Consult skills by reading their SKILL.md files (grilling, domain-modeling, research,
   wayfinder, codebase-design, to-spec, to-tickets, implement, prototype, triage).
4. Before ending: append log.md (`## [YYYY-MM-DD] type | title` + 1–3 sentences), update
   index.md, resolve tickets (resolution comment → close → "Decisions so far" line → graduate
   fog into fresh tickets), write ADRs WITH BENCHMARK EVIDENCE, file benchmark reports.
5. Periodic lint pass: contradictions, stale claims, orphans, superseded-by marks.

## Layout
- `log.md` — append-only session log.
- `index.md` — categorized links with one-line annotations.
- `decisions/NNNN-slug.md` — ADRs: frontmatter (status/date/deciders) + Context/Decision/
  Alternatives/Evidence. Locked decisions reopen only via new ADR + user approval.
- `context/research/` — round briefs (raw sources are summarized here, never edited) +
  port-dossier/ (pre-goal deep-read).
- `benchmark/` — spec (lands at CP1) + runs/ reports citing exact commands/run ids.
- `wayfinder/` — map: destination, decisions-so-far, fog list, out-of-scope (charted at Phase 2).

## Standing rules
- Repo is a fork of milind-soni/OpenMausBot (Apache-2.0): never push upstream; keep LICENSE/
  NOTICE/third_party provenance intact; avenza-derived files note their origin.
- Quality gates: typecheck, 3-OS test floor ≥1070, oxlint anti-slop, packaged-server smoke,
  paired migrations, engine module ≤600 lines.
