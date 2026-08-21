// GoalManager mechanics: structural round reservation, honest terminal
// recording, the continuation decision (succeeded closes; anything else
// earns another round until the cap), prompt synthesis that feeds learned
// context forward, and persistence that survives a manager rebuild.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { removeTempDir } from "../testing/cleanup.ts";

const { GoalManager } = await import("./goals.ts");

let dir: string;
let file: string;
let followUps: Array<{ goalId: string; prompt: string }>;
let manager: InstanceType<typeof GoalManager>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omb-goals-"));
  file = join(dir, "goals.json");
  followUps = [];
  manager = new GoalManager(file, {
    startFollowUpTurn: (goal, prompt) => followUps.push({ goalId: goal.goal_id, prompt }),
  });
});

afterEach(async () => {
  await removeTempDir(dir);
});

describe("GoalManager", () => {
  it("reserves rounds structurally and rejects duplicates", () => {
    const goal = manager.createGoal({ thread_id: "th1", bot_id: "b1", objective: "reconcile invoices" });
    expect(manager.startGoalRound(goal.goal_id, "turn-1")).toEqual({ kind: "started", round_no: 1 });
    expect(manager.startGoalRound(goal.goal_id, "turn-1")).toEqual({ kind: "duplicate_round", round_no: 1 });
  });

  it("refuses rounds on unknown, inactive, or exhausted goals", () => {
    expect(manager.startGoalRound("nope", "t")).toEqual({ kind: "not_found" });
    const goal = manager.createGoal({ thread_id: "th2", bot_id: "b1", objective: "x", max_rounds: 1 });
    manager.startGoalRound(goal.goal_id, "t1");
    manager.recordRound(goal.goal_id, 1, { outcome: "failed" });
    // failed does NOT close the goal — but the cap blocks further rounds
    expect(manager.continueOrClose(goal.goal_id)).toBeNull();
    expect(manager.get(goal.goal_id)?.state).toBe("blocked");
  });

  it("records terminal outcomes exactly once per round", () => {
    const goal = manager.createGoal({ thread_id: "th3", bot_id: "b1", objective: "y" });
    manager.startGoalRound(goal.goal_id, "t1");
    expect(manager.recordRound(goal.goal_id, 1, { outcome: "timed_out", error: "budget" })).toBe(true);
    expect(manager.recordRound(goal.goal_id, 1, { outcome: "succeeded" })).toBe(false);
    expect(manager.get(goal.goal_id)?.rounds[0]).toMatchObject({ outcome: "timed_out", error: "budget" });
  });

  it("success closes the goal; failure continues with a synthesized prompt", () => {
    const done = manager.createGoal({ thread_id: "th4", bot_id: "b1", objective: "ship it" });
    manager.startGoalRound(done.goal_id, "t1");
    manager.recordRound(done.goal_id, 1, { outcome: "succeeded", context_summary: "all matched" });
    expect(manager.continueOrClose(done.goal_id)).toBeNull();
    expect(manager.get(done.goal_id)?.state).toBe("complete");

    const ongoing = manager.createGoal({ thread_id: "th5", bot_id: "b1", objective: "process claims" });
    manager.startGoalRound(ongoing.goal_id, "t2");
    manager.recordRound(ongoing.goal_id, 1, { outcome: "failed", context_summary: "2 of 5 claims done" });
    const next = manager.continueOrClose(ongoing.goal_id);
    expect(next).toBe(2);
    expect(followUps).toHaveLength(1);
    expect(followUps[0].prompt).toContain("Objective: process claims");
    expect(followUps[0].prompt).toContain("Round 1 [failed]: 2 of 5 claims done");
    expect(followUps[0].prompt).toContain("Do not redo completed work");
  });

  it("persists across a manager rebuild (restart survival)", () => {
    const goal = manager.createGoal({ thread_id: "th6", bot_id: "b1", objective: "survive" });
    manager.startGoalRound(goal.goal_id, "t1");
    manager.recordRound(goal.goal_id, 1, { outcome: "stopped", cost_usd: 0.5, active_ms: 42_000 });

    const reborn = new GoalManager(file, { startFollowUpTurn: vi.fn() });
    const restored = reborn.get(goal.goal_id);
    expect(restored?.state).toBe("active");
    expect(restored?.rounds[0]).toMatchObject({ outcome: "stopped", cost_usd: 0.5, active_ms: 42_000 });
    expect(JSON.parse(readFileSync(file, "utf8")).version).toBe(1);
  });

  it("truncates oversized context summaries to the avenza cap", () => {
    const goal = manager.createGoal({ thread_id: "th7", bot_id: "b1", objective: "z" });
    manager.startGoalRound(goal.goal_id, "t1");
    manager.recordRound(goal.goal_id, 1, { outcome: "failed", context_summary: "x".repeat(9000) });
    expect(manager.get(goal.goal_id)?.rounds[0]?.context_summary).toHaveLength(4000);
  });
});
