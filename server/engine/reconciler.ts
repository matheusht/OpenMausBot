// Boot-time reconciler — the piece Temporal gave avenza for free and this
// port builds by hand (ADR 0003). After a crash:
//   - event_outbox rows may be committed-but-unpublished; their listeners
//     are gone, so the log itself is the record — mark them published.
//   - `omb-mcp-*` credential tempdirs are created per turn and removed at
//     settle; a SIGKILL leaks them. Sweep stale ones (age-gated so a
//     concurrently running second instance never loses a live dir).
// Orphan CLI process groups additionally require persisted child pgids
// (none exist yet) — tracked in wayfinder ticket #5.
import { readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MCP_TMP_PREFIX = "omb-mcp-";
const STALE_TMP_MS = 60 * 60 * 1000;

/** Mark every unpublished outbox row published. Returns how many. */
export function reconcileEventLog(drain: () => Array<{ turn_id: string; seq: number }>, mark: (turnId: string, seq: number) => void): number {
  const pending = drain();
  for (const row of pending) mark(row.turn_id, row.seq);
  return pending.length;
}

/** Remove leaked MCP credential tempdirs older than the staleness gate. */
export function sweepMcpTmpdirs(now: number = Date.now()): number {
  let swept = 0;
  let entries: string[] = [];
  try {
    entries = readdirSync(tmpdir());
  } catch {
    return 0;
  }
  for (const name of entries) {
    if (!name.startsWith(MCP_TMP_PREFIX)) continue;
    const path = join(tmpdir(), name);
    try {
      if (now - statSync(path).mtimeMs < STALE_TMP_MS) continue;
      rmSync(path, { recursive: true, force: true });
      swept += 1;
    } catch {
      /* a dir another process holds will not unlink; skip it */
    }
  }
  return swept;
}
