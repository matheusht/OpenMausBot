// Plan mode as logged state — avenza C2 (ADR 0003 borrow). The whole plan
// is one value per conversation with a revision counter; every mutation
// emits a narrative event through the injected emitter so the transcript
// shows WHEN the plan changed, not just what it is now. The active plan is
// injected into the system prompt at turn start by the caller.
import { existsSync, readFileSync } from "node:fs";

import { writeFileAtomic } from "../atomic.ts";

export interface PlanRecord {
  thread_id: string;
  mode: "active" | "inactive";
  plan_text: string | null;
  revision: number;
  updated_at: string;
}

interface PlanStoreFile {
  version: 1;
  plans: Record<string, PlanRecord>;
}

export class PlanStore {
  private plans: Record<string, PlanRecord> = {};

  constructor(
    private readonly dataFile: string,
    /** emits a narrative event for the transcript; injected for testability */
    private readonly emit: (event: { family: "narrative"; kind: "plan_updated"; item_id: string; payload: unknown }) => void,
  ) {
    if (!existsSync(dataFile)) return;
    try {
      const raw = JSON.parse(readFileSync(dataFile, "utf8"));
      // SAFETY: the file is only ever written by save(); a torn or foreign
      // file throws above and starts the store empty.
      this.plans = (raw as PlanStoreFile).plans ?? {};
    } catch {
      this.plans = {};
    }
  }

  private save(): void {
    const file: PlanStoreFile = { version: 1, plans: this.plans };
    writeFileAtomic(this.dataFile, JSON.stringify(file, null, 2), { mode: 0o600 });
  }

  private record(threadId: string): PlanRecord {
    const existing = this.plans[threadId];
    if (existing) return existing;
    const record: PlanRecord = {
      thread_id: threadId,
      mode: "inactive",
      plan_text: null,
      revision: 0,
      updated_at: new Date().toISOString(),
    };
    this.plans[threadId] = record;
    return record;
  }

  setPlan(threadId: string, planText: string): PlanRecord {
    const record = this.record(threadId);
    record.mode = "active";
    record.plan_text = planText;
    record.revision += 1;
    record.updated_at = new Date().toISOString();
    this.save();
    this.emit({ family: "narrative", kind: "plan_updated", item_id: threadId, payload: { mode: record.mode, revision: record.revision } });
    return record;
  }

  clearPlan(threadId: string): PlanRecord {
    const record = this.record(threadId);
    record.mode = "inactive";
    record.revision += 1;
    record.updated_at = new Date().toISOString();
    this.save();
    this.emit({ family: "narrative", kind: "plan_updated", item_id: threadId, payload: { mode: record.mode, revision: record.revision } });
    return record;
  }

  /** The text to inject as a system message when mode is active, else null. */
  activePlanText(threadId: string): string | null {
    const record = this.plans[threadId];
    if (!record || record.mode !== "active") return null;
    return record.plan_text;
  }
}
