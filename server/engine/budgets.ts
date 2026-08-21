// Turn budget policy — ported from avenza tool-loop/budgets.ts (ADR 0003,
// borrow-and-reimplement). Pure functions only: no clock, no I/O, so any
// host can call it and tests stay deterministic.
//
// Four budget classes per turn/goal-round. Crossing 80% of a class is a
// SOFT crossing: the caller injects exactly one convergence nudge for that
// class (dedup is the caller's job — see softNudged in avenza's loop).
// Reaching 100% is HARD: the turn must end, with an honest outcome —
// time/iteration exhaustion is `timed_out`, everything else `failed`.
export interface BudgetLimits {
  maxIterations: number;
  maxActiveMs: number;
  /** fraction of the context window held back for the answer */
  contextReserveFraction: number;
  maxCostUsd: number;
}

export const DEFAULT_BUDGET_LIMITS: BudgetLimits = {
  maxIterations: 60,
  maxActiveMs: 15 * 60 * 1000,
  contextReserveFraction: 0.2,
  maxCostUsd: 5,
};

const SOFT_THRESHOLD_FRACTION = 0.8;

export interface BudgetUsage {
  iterations: number;
  activeMs: number;
  contextTokensUsed: number;
  contextWindowTokens: number;
  costUsd: number;
}

export type BudgetClass = "iterations" | "active_time" | "context" | "cost";

export interface BudgetHardBreach {
  class: BudgetClass;
  outcome: "timed_out" | "failed";
}

export interface BudgetCheckResult {
  /** every class currently at/over the soft threshold */
  softCrossed: BudgetClass[];
  /** at most one; iteration/time exhaustion checked first */
  hard: BudgetHardBreach | null;
}

/** The usable window is what's left after the answer reserve. */
function usableContextTokens(usage: BudgetUsage, limits: BudgetLimits): number {
  return Math.max(0, usage.contextWindowTokens * (1 - limits.contextReserveFraction));
}

export function checkBudgets(usage: BudgetUsage, limits: BudgetLimits = DEFAULT_BUDGET_LIMITS): BudgetCheckResult {
  const softCrossed: BudgetClass[] = [];
  const crossed = (fraction: number): boolean => fraction >= SOFT_THRESHOLD_FRACTION;

  const iterationFraction = usage.iterations / limits.maxIterations;
  const activeFraction = usage.activeMs / limits.maxActiveMs;
  const contextFraction =
    usage.contextWindowTokens > 0 ? usage.contextTokensUsed / usableContextTokens(usage, limits) : 0;
  const costFraction = usage.costUsd / limits.maxCostUsd;

  if (crossed(iterationFraction)) softCrossed.push("iterations");
  if (crossed(activeFraction)) softCrossed.push("active_time");
  if (crossed(contextFraction)) softCrossed.push("context");
  if (crossed(costFraction)) softCrossed.push("cost");

  let hard: BudgetHardBreach | null = null;
  if (iterationFraction >= 1 || activeFraction >= 1) hard = { class: iterationFraction >= 1 ? "iterations" : "active_time", outcome: "timed_out" };
  else if (usage.contextWindowTokens > 0 && usage.contextTokensUsed >= usableContextTokens(usage, limits)) hard = { class: "context", outcome: "failed" };
  else if (costFraction >= 1) hard = { class: "cost", outcome: "failed" };

  return { softCrossed, hard };
}
