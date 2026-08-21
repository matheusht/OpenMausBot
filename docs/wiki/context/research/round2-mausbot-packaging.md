# Round 2 — Electron/packaging/test-floor constraints (mausbot)

Source: subagent deep-read, 2026-08-20.

## 1. Electron embedding (`electron/main.mjs`)

- Fork: `utilityProcess.fork(path.join(process.resourcesPath, "server", "index.js"))` with `stdio:["ignore","pipe","pipe"]`, stdout/stderr teed to log (`main.mjs:208-242`). Identity check after boot: `/api/health` must return `app==="openmausbot" && pid===proc.pid && static` (`main.mjs:247-260`).
- Ports `[8799, 18799, 28799]` tried in order, two passes for quit-and-reopen races (`main.mjs:267-282`); renderer learns `SERVER_PORT` dynamically (295–297). New endpoints must not assume fixed port.
- Env passed to server (`main.mjs:212-232`): `OMB_STATIC_DIR`, `OMB_RESOURCES_PATH`, `OMB_SKILLS_DIR`, `OMB_PORT`, `OMB_USER_DATA`, per-secret env. A capability flag (e.g. `OMB_HARNESS_INTERNAL=1`) rides this env object — Electron must never set eval flags.
- Data dir: `DATA_DIR = OMB_DATA_DIR ?? ~/.openmausbot` (`config.ts:115`); Electron does not set `OMB_DATA_DIR`, so packaged apps use `~/.openmausbot` too. Updater never restarts the server child directly.

## 2. Server bundling (`scripts/bundle-server.mjs`, `tsconfig.server.build.json`)

Pipeline: tsc (ES2023/NodeNext, excludes tests + `server/testing`) then esbuild `bundle:true, platform:node, target:"node20", format:"esm"` over 9 entry points (`bundle-server.mjs:28-50`); entry relative paths preserved via outbase (proxy prefers `.ts` in dev, sibling `.js` in bundle).

Implications:
- `node:sqlite` fine and precedented (message-db.ts:15); CI runs Node 24 (`ci.yml:32`).
- Bare imports inlined by esbuild — adding npm deps grows bundle; zero-node_modules is the invariant (`bundle-server.mjs:3-7`, the 0.1.24 incident).
- Top-level await OK; keep `.ts` extension imports; new entry points must be added to `ENTRY_POINTS`.
- `import.meta.url` relocates under bundling — never resolve siblings naively.

## 3. Smoke + test floor

- `test:packaged-server` = build:server + smoke: copies dist-server outside repo (bare imports can't resolve from node_modules), boots index.js with only PATH/HOME, asserts /api/health within 45 s, probes every SPAWNED_PROXIES path exists (`smoke-packaged-server.mjs:27-39,61-118`). New internal routes fine as long as server boots dependency-free.
- `test-floor.mjs`: wraps vitest with JSON reporter; `TEST_COUNT_FLOOR = 1070` vs last full run 1091. Counts registered tests; skipped tests count. **Adding tests is free** (floor is lower bound). Targeted runs bypass floor. New test files must match vitest globs or they silently don't count.

## 4. CI checks & lint

ci.yml test job (3 OS): typecheck → test (floor + broker + updater + packaged-server smoke) → check:electron → vite build on Ubuntu. Packaging jobs: linux (offline CUA, verify-linux-package, smoke) + iOS. `check-electron.mjs` syntax-checks electron files — hard gate, irrelevant to server files. Lint: `oxlint .` with anti-slop plugin (`.oxlintrc.json:22-44`): errors include `no-object-parameters`, `no-chained-type-assertions`, `require-safety-comment-for-type-assertion`, `no-module-mocking`, `no-unknown-returns`. New engine files: named args/typed options interfaces, safety comments on `as` casts, no module mocking in tests. Lint not in ci.yml steps — run locally.

## 5. Flag-gating precedent for internal endpoints

Three tiers to copy:
1. Loopback + Host/origin guard applies to everything (`index.ts:2238-2270`).
2. Shared-secret internal tier: `/api/internal/*` requires `authorizedComms` bearer (per-boot random token, constant-time compare, `index.ts:119-131`, guard at 2290-2293) — right model for eval-seed/goal APIs called by local tooling receiving token via env.
3. Env-flag gating: `STATIC_DIR` mode precedent (`index.ts:98`). Eval endpoints should require BOTH a flag env (never set by `main.mjs:212-232`) AND sit under `/api/internal/`. Packaged apps physically cannot enable it.

## 6. Companion sidecar & broker

Companion proxies device traffic through default-deny route allowlist (`companion/src/routes.ts:53-89,124-137`) — new harness routes invisible to phones unless deliberately added; SSE `/api/events` allowed (57); new SSE stream needs explicit allowlist entry + scrubber treatment (`companion/src/wire.ts` scrubs resumeCursors). Control plane :8811 loopback-only strict origin allowlist; :8810 binds 0.0.0.0 token-authenticated. Cloudflare broker unrelated to local routes.

## 7. Data-dir growth

Adding events.db needs no new dir (EVENTS_DIR or DATA_DIR); goals.json belongs in DATA_DIR next to bots.json/routines.json, written tmp+rename like `routines.ts:563-568`. Windows caveats visible in code: rename-over-open-file retries (`smoke-packaged-server.mjs:45-58`), named-pipe global namespace vs POSIX sockets (`procs.ts:112-119`), DBs holding decision-grade data should open restrictive perms like NDJSON tees.

## PR gate checklist

- [ ] `pnpm typecheck`
- [ ] `pnpm test` green on 3 OS ⇒ floor ≥1070 + broker + updater + packaged-server smoke
- [ ] `pnpm lint` (anti-slop rules on new files)
- [ ] `pnpm check:electron` untouched
- [ ] New routes: loopback guard + `/api/internal/` token check + opt-in env flag NOT set by electron/main.mjs
- [ ] New data files under DATA_DIR/EVENTS_DIR via ensureDirs; atomic writes; 0600
- [ ] No new runtime dep without esbuild-bundle justification; new spawned entries added to ENTRY_POINTS
- [ ] Companion allowlist untouched (or consciously extended with scrubbing)
