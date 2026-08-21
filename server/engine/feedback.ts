// Feedback recording — avenza C3, contract A (ADR 0003): feedback is a
// LOG-ONLY capture event. It is stored here and nowhere else; no context-
// assembly path reads this file. The class deliberately exposes no method
// that returns feedback content for prompting — that absence IS the
// contract, enforced by review and by the test pinning it.
import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

import { writeFileAtomic } from "../atomic.ts";

export interface FeedbackRecord {
  feedback_id: string;
  turn_id: string;
  thread_id: string;
  kind: "remark" | "rating";
  rating?: number;
  content: string;
  created_at: string;
}

interface FeedbackFile {
  version: 1;
  records: FeedbackRecord[];
}

export class FeedbackLog {
  private records: FeedbackRecord[] = [];

  constructor(
    private readonly dataFile: string,
    private readonly emit: (event: { family: "capture"; kind: "feedback_recorded"; item_id: string; payload: unknown }) => void,
  ) {
    if (!existsSync(dataFile)) return;
    try {
      const raw = JSON.parse(readFileSync(dataFile, "utf8"));
      // SAFETY: written only by save(); torn/foreign files start empty.
      this.records = (raw as FeedbackFile).records ?? [];
    } catch {
      this.records = [];
    }
  }

  private save(): void {
    const file: FeedbackFile = { version: 1, records: this.records };
    writeFileAtomic(this.dataFile, JSON.stringify(file, null, 2), { mode: 0o600 });
  }

  record(input: { turn_id: string; thread_id: string; kind: "remark" | "rating"; rating?: number; content: string }): FeedbackRecord {
    const record: FeedbackRecord = {
      feedback_id: randomUUID(),
      turn_id: input.turn_id,
      thread_id: input.thread_id,
      kind: input.kind,
      content: input.content,
      created_at: new Date().toISOString(),
    };
    if (input.rating !== undefined) record.rating = input.rating;
    this.records.push(record);
    this.save();
    // The capture event carries only provenance, never the content —
    // mirrors avenza's log-only discipline.
    this.emit({
      family: "capture",
      kind: "feedback_recorded",
      item_id: record.feedback_id,
      payload: { turn_id: record.turn_id, kind: record.kind },
    });
    return record;
  }

  /** Audit/diagnostics only — never prompt assembly. */
  count(): number {
    return this.records.length;
  }
}
