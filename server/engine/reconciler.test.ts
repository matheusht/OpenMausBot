// Reconciler mechanics: outbox drain marks everything published, and the
// tmpdir sweep takes only stale omb-mcp-* dirs, leaving fresh ones (a
// concurrently running instance's live credentials) alone.
import { mkdirSync, mkdtempSync, statSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { removeTempDir } from "../testing/cleanup.ts";

const { reconcileEventLog, sweepMcpTmpdirs } = await import("./reconciler.ts");

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omb-reconciler-"));
});

afterEach(async () => {
  await removeTempDir(dir);
});

describe("reconcileEventLog", () => {
  it("marks every unpublished row published and reports the count", () => {
    const pending = [
      { turn_id: "t1", seq: 1 },
      { turn_id: "t1", seq: 2 },
      { turn_id: "t2", seq: 1 },
    ];
    const marked: Array<{ turn_id: string; seq: number }> = [];
    const count = reconcileEventLog(
      () => pending,
      (turnId, seq) => marked.push({ turn_id: turnId, seq }),
    );
    expect(count).toBe(3);
    expect(marked).toEqual(pending);
  });

  it("reports zero when nothing is pending", () => {
    expect(reconcileEventLog(() => [], () => {})).toBe(0);
  });
});

describe("sweepMcpTmpdirs", () => {
  it("removes only stale omb-mcp-* directories", () => {
    const stale = join(tmpdir(), "omb-mcp-stale-test");
    const fresh = join(tmpdir(), "omb-mcp-fresh-test");
    const foreign = join(tmpdir(), "unrelated-dir-test");
    mkdirSync(stale, { recursive: true });
    mkdirSync(fresh, { recursive: true });
    mkdirSync(foreign, { recursive: true });
    writeFileSync(join(stale, "creds"), "x");
    // backdate the stale dir beyond the gate; bump fresh to now
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(stale, old, old);
    const now = new Date();
    utimesSync(fresh, now, now);
    try {
      const swept = sweepMcpTmpdirs();
      void swept; // other tests may have leaked dirs; assert on our own paths
      let exists = (path: string): boolean => {
        try {
          statSync(path);
          return true;
        } catch {
          return false;
        }
      };
      expect(exists(stale)).toBe(false);
      expect(exists(fresh)).toBe(true);
      expect(exists(foreign)).toBe(true);
    } finally {
      for (const path of [stale, fresh, foreign]) {
        try {
          statSync(path);
          rmSync(path, { recursive: true, force: true });
        } catch {}
      }
    }
  });
});
