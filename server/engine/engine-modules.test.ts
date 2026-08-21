// The remaining engine modules: bounded HITL waits over injected event
// subscriptions, plan mode as a logged whole-value fold, and feedback that
// stays log-only (contract A: no context-assembly path can read it).
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { removeTempDir } from "../testing/cleanup.ts";
import type { HitlEvent } from "./hitl.ts";

const { HitlWaiter } = await import("./hitl.ts");
const { PlanStore } = await import("./plan-state.ts");
const { FeedbackLog } = await import("./feedback.ts");

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omb-engine2-"));
});

afterEach(async () => {
  await removeTempDir(dir);
});

/** Builds a waiter plus a manual emit handle, the way the bus would wire it. */
function makeWaiter() {
  let handler: ((event: HitlEvent) => void) | null = null;
  const waiter = new HitlWaiter((h) => {
    handler = h;
    return () => {
      handler = null;
    };
  });
  return {
    waiter,
    emit(event: HitlEvent): void {
      handler?.(event);
    },
  };
}

describe("HitlWaiter", () => {
  it("resolves with the behavior when request.resolved arrives", async () => {
    const { waiter, emit } = makeWaiter();
    const pending = waiter.wait("req-1", 1000);
    emit({ kind: "request.resolved", requestId: "req-1", behavior: "allowed-once" });
    await expect(pending).resolves.toEqual({ status: "resolved", behavior: "allowed-once" });
  });

  it("times out when nothing resolves in the window", async () => {
    const { waiter } = makeWaiter();
    await expect(waiter.wait("req-2", 10)).resolves.toEqual({ status: "timeout" });
  });

  it("ignores resolutions for other requests", async () => {
    const { waiter, emit } = makeWaiter();
    const pending = waiter.wait("mine", 50);
    emit({ kind: "request.resolved", requestId: "theirs", behavior: "rejected" });
    await expect(pending).resolves.toEqual({ status: "timeout" });
  });
});

describe("PlanStore", () => {
  it("folds set/clear into revisioned records and emits narrative events", () => {
    const events: Array<{ kind: string; payload: unknown }> = [];
    const store = new PlanStore(join(dir, "plans.json"), (event) => events.push(event));
    store.setPlan("th1", "1. intake\n2. triage\n3. review gate");
    const active = store.activePlanText("th1");
    expect(active).toContain("review gate");
    store.clearPlan("th1");
    expect(store.activePlanText("th1")).toBeNull();
    expect(events.map((e) => e.kind)).toEqual(["plan_updated", "plan_updated"]);
    expect(store.activePlanText("other")).toBeNull();
  });

  it("persists across a rebuild and keeps the revision counter", () => {
    const file = join(dir, "plans.json");
    const emitted: unknown[] = [];
    const first = new PlanStore(file, () => emitted.push(1));
    first.setPlan("th2", "step one");
    first.setPlan("th2", "step one + two");

    const reborn = new PlanStore(file, vi.fn());
    expect(reborn.activePlanText("th2")).toBe("step one + two");
    expect(JSON.parse(readFileSync(file, "utf8")).plans.th2.revision).toBe(2);
  });
});

describe("FeedbackLog (contract A)", () => {
  it("records remarks and ratings, emitting provenance-only capture events", () => {
    const events: Array<{ kind: string; payload: unknown }> = [];
    const log = new FeedbackLog(join(dir, "feedback.json"), (event) => events.push(event));
    const record = log.record({ turn_id: "t1", thread_id: "th1", kind: "rating", rating: 4, content: "too slow on gates" });
    expect(record.feedback_id).toBeTruthy();
    expect(log.count()).toBe(1);
    // The event carries provenance only — content never rides the stream.
    expect(events[0].kind).toBe("feedback_recorded");
    expect(JSON.stringify(events[0].payload)).not.toContain("too slow");
  });

  it("survives a rebuild", () => {
    const file = join(dir, "feedback.json");
    const first = new FeedbackLog(file, vi.fn());
    first.record({ turn_id: "t1", thread_id: "th1", kind: "remark", content: "note" });
    const reborn = new FeedbackLog(file, vi.fn());
    expect(reborn.count()).toBe(1);
  });
});
