// Budget policy: soft crossings at 80%, hard breaches with honest outcomes,
// the context reserve shrinking the usable window, and iteration/time
// exhaustion winning the tie over cost.
import { describe, expect, it } from "vitest";

import { checkBudgets, DEFAULT_BUDGET_LIMITS } from "./budgets.ts";

const usage = (overrides: Partial<Parameters<typeof checkBudgets>[0]> = {}) => ({
  iterations: 0,
  activeMs: 0,
  contextTokensUsed: 0,
  contextWindowTokens: 100_000,
  costUsd: 0,
  ...overrides,
});

describe("checkBudgets", () => {
  it("is quiet when nothing is spent", () => {
    expect(checkBudgets(usage())).toEqual({ softCrossed: [], hard: null });
  });

  it("flags a soft crossing at exactly 80% of a class", () => {
    const result = checkBudgets(usage({ iterations: 0.8 * DEFAULT_BUDGET_LIMITS.maxIterations }));
    expect(result.softCrossed).toEqual(["iterations"]);
    expect(result.hard).toBeNull();
  });

  it("computes context against the usable window, not the raw window", () => {
    // usable = 100k * (1 - 0.2) = 80k; 70k used is ~87% — soft, not hard.
    const result = checkBudgets(usage({ contextTokensUsed: 70_000 }));
    expect(result.softCrossed).toEqual(["context"]);
    expect(result.hard).toBeNull();
  });

  it("hard-fails context only past the usable window", () => {
    const result = checkBudgets(usage({ contextTokensUsed: 81_000 }));
    expect(result.hard).toEqual({ class: "context", outcome: "failed" });
  });

  it("reports timed_out for iteration exhaustion before cost failure", () => {
    const result = checkBudgets(usage({ iterations: DEFAULT_BUDGET_LIMITS.maxIterations + 1, costUsd: 99 }));
    expect(result.hard).toEqual({ class: "iterations", outcome: "timed_out" });
  });

  it("reports timed_out for active-time exhaustion", () => {
    const result = checkBudgets(usage({ activeMs: DEFAULT_BUDGET_LIMITS.maxActiveMs + 1 }));
    expect(result.hard).toEqual({ class: "active_time", outcome: "timed_out" });
  });

  it("reports failed for cost exhaustion", () => {
    const result = checkBudgets(usage({ costUsd: DEFAULT_BUDGET_LIMITS.maxCostUsd + 1 }));
    expect(result.hard).toEqual({ class: "cost", outcome: "failed" });
  });

  it("accumulates every soft crossing independently", () => {
    const result = checkBudgets(
      usage({
        iterations: DEFAULT_BUDGET_LIMITS.maxIterations - 1,
        activeMs: DEFAULT_BUDGET_LIMITS.maxActiveMs - 1,
        contextTokensUsed: 79_000,
        costUsd: DEFAULT_BUDGET_LIMITS.maxCostUsd - 0.01,
      }),
    );
    expect(result.softCrossed).toEqual(["iterations", "active_time", "context", "cost"]);
    expect(result.hard).toBeNull();
  });
});
