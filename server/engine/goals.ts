// Durable goal state driving chain-of-rounds — the port's C1 core
// (ADR 0003). avenza insight kept: a goal is a row of record whose rounds
// are reserved structurally (unique round numbers), and CONTINUATION IS A
// WORKFLOW-SIDE DECISION — when a round's turn completes, the manager
// decides whether the goal earns another round, synthesizes the next
// prompt from what happened, and hands it to an injected dispatcher.
//
// Persistence follows the house JSON-store pattern (routines.json /
// webhooks.json): whole-file atomic write via writeFileAtomic. The file
// survives restarts; a crash loses only the in-flight round.
import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

import { writeFileAtomic } from "../atomic.ts";

export type GoalState = "active" | "paused" | "blocked" | "complete";
export type RoundOutcome = "in_progress" | "succeeded" | "failed" | "stopped" | "cancelled" | "timed_out";

export interface GoalRound {
  round_no: number;
  turn_id: string;
  outcome: RoundOutcome;
  error?: string;
  started_at: string;
  completed_at?: string;
  /** final text + cost/active-ms summary fed into the next round's prompt */
  context_summary?: string;
  cost_usd?: number;
  active_ms?: number;
}

export interface GoalRecord {
  goal_id: string;
  thread_id: string;
  bot_id: string;
  objective: string;
  state: GoalState;
  revision: number;
  rounds: GoalRound[];
  max_rounds: number;
  created_at: string;
  updated_at: string;
}

export interface GoalStoreFile {
  version: 1;
  goals: GoalRecord[];
}

export interface StartGoalRoundResult {
  kind: "started" | "not_found" | "not_active" | "round_limit" | "duplicate_round";
  round_no?: number;
  state?: GoalState;
}

const TERMINAL_OUTCOMES: ReadonlySet<RoundOutcome> = new Set(["succeeded", "failed", "stopped", "cancelled", "timed_out"]);

export class GoalManager {
  private goals = new Map<string, GoalRecord>();

  constructor(
    private readonly dataFile: string,
    private readonly deps: {
      /** dispatches the follow-up turn; injected so the manager stays I/O-free */
      startFollowUpTurn: (goal: GoalRecord, prompt: string) => void;
    },
  ) {
    this.load();
  }

  private load(): void {
    if (!existsSync(this.dataFile)) return;
    try {
      const raw = JSON.parse(readFileSync(this.dataFile, "utf8"));
      // SAFETY: the file is only ever written by save() as a GoalStoreFile;
      // a foreign or torn file throws above and starts the store empty.
      for (const goal of (raw as GoalStoreFile).goals ?? []) this.goals.set(goal.goal_id, goal);
    } catch {
      // A torn store starts empty — same posture as delegations.json.
      this.goals.clear();
    }
  }

  private save(): void {
    const store: GoalStoreFile = { version: 1, goals: [...this.goals.values()] };
    writeFileAtomic(this.dataFile, JSON.stringify(store, null, 2), { mode: 0o600 });
  }

  createGoal(input: { thread_id: string; bot_id: string; objective: string; max_rounds?: number }): GoalRecord {
    const now = new Date().toISOString();
    const goal: GoalRecord = {
      goal_id: randomUUID(),
      thread_id: input.thread_id,
      bot_id: input.bot_id,
      objective: input.objective,
      state: "active",
      revision: 1,
      rounds: [],
      max_rounds: input.max_rounds ?? 20,
      created_at: now,
      updated_at: now,
    };
    this.goals.set(goal.goal_id, goal);
    this.save();
    return goal;
  }

  get(goalId: string): GoalRecord | null {
    return this.goals.get(goalId) ?? null;
  }

  getByThread(threadId: string): GoalRecord | null {
    for (const goal of this.goals.values()) {
      if (goal.thread_id === threadId && goal.state === "active") return goal;
    }
    return null;
  }

  startGoalRound(goalId: string, turnId: string): StartGoalRoundResult {
    const goal = this.goals.get(goalId);
    if (!goal) return { kind: "not_found" };
    if (goal.state !== "active") return { kind: "not_active", state: goal.state };
    if (goal.rounds.length >= goal.max_rounds) return { kind: "round_limit" };
    // Structural reservation, mirroring avenza's UNIQUE(goal_id, round_no):
    // exactly one in-flight round at a time — a second start while a round
    // has not reached a terminal outcome is a duplicate dispatch.
    const inFlight = goal.rounds.find((round) => !TERMINAL_OUTCOMES.has(round.outcome));
    if (inFlight) return { kind: "duplicate_round", round_no: inFlight.round_no };
    const roundNo = goal.rounds.length + 1;
    goal.rounds.push({ round_no: roundNo, turn_id: turnId, outcome: "in_progress", started_at: new Date().toISOString() });
    goal.revision += 1;
    goal.updated_at = new Date().toISOString();
    this.save();
    return { kind: "started", round_no: roundNo };
  }

  recordRound(
    goalId: string,
    roundNo: number,
    result: { outcome: RoundOutcome; error?: string; context_summary?: string; cost_usd?: number; active_ms?: number },
  ): boolean {
    const goal = this.goals.get(goalId);
    if (!goal) return false;
    const round = goal.rounds.find((candidate) => candidate.round_no === roundNo);
    if (!round || TERMINAL_OUTCOMES.has(round.outcome)) return false;
    round.outcome = result.outcome;
    round.completed_at = new Date().toISOString();
    if (result.error !== undefined) round.error = result.error;
    if (result.context_summary !== undefined) round.context_summary = result.context_summary.slice(0, 4000);
    if (result.cost_usd !== undefined) round.cost_usd = result.cost_usd;
    if (result.active_ms !== undefined) round.active_ms = result.active_ms;
    goal.revision += 1;
    goal.updated_at = new Date().toISOString();
    if (result.outcome === "succeeded") goal.state = "complete";
    this.save();
    return true;
  }

  /**
   * The continuation decision, made after every round-terminal event:
   * succeeded ends the goal; anything else earns another round while the
   * cap holds. Returns the round number started, or null.
   */
  continueOrClose(goalId: string): number | null {
    const goal = this.goals.get(goalId);
    if (!goal || goal.state !== "active") return null;
    if (goal.rounds.length >= goal.max_rounds) {
      goal.state = "blocked";
      goal.updated_at = new Date().toISOString();
      this.save();
      return null;
    }
    const prompt = this.nextRoundPrompt(goal);
    this.deps.startFollowUpTurn(goal, prompt);
    return goal.rounds.length + 1;
  }

  /** The next round's user text: objective plus what previous rounds learned. */
  nextRoundPrompt(goal: GoalRecord): string {
    const lines = [`Objective: ${goal.objective}`, "", "Progress so far:"];
    for (const round of goal.rounds) {
      const summary = round.context_summary ?? `round ended (${round.outcome})`;
      lines.push(`- Round ${round.round_no} [${round.outcome}]: ${summary}`);
    }
    lines.push("", "Continue working toward the objective. Do not redo completed work.");
    return lines.join("\n");
  }

  all(): GoalRecord[] {
    return [...this.goals.values()];
  }
}
