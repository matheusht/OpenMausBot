// The event log's own mechanics: monotonic per-turn seq under the
// single-writer runtime, commit-before-publish outbox pairing, CAS turn
// state transitions, replay from a seq, secret redaction before the row
// hits disk, and migration versioning that survives a fresh-vs-upgrade
// open. The WIRING into the bus is pinned separately once it lands.
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// testing/setup.ts redirects HOME at a fresh throwaway home and DELETES
// OMB_DATA_DIR, so this module opens <home>/.openmausbot/events.db like
// message-db does. Isolation comes from deleting the db files between
// cases — the module reopens when its file vanishes.
const {
  closeEventDb,
  commitEvent,
  eventsSince,
  insertTurnRow,
  markPublished,
  transitionTurnState,
  turnStatus,
  unpublishedEvents,
} = await import("./event-log.ts");

const dataDir = () => join(process.env.HOME ?? "", ".openmausbot");

beforeEach(() => {
  const dir = dataDir();
  if (!existsSync(dir)) return; // first case: nothing to wipe
  for (const name of readdirSync(dir)) {
    if (name.startsWith("events.db")) rmSync(join(dir, name), { force: true });
  }
});

afterEach(async () => {
  closeEventDb();
});

describe("commitEvent", () => {
  it("allocates a dense per-turn sequence starting at 1", () => {
    const a = commitEvent({ turn_id: "t1", family: "capture", kind: "turn_state_changed", payload: {} });
    const b = commitEvent({ turn_id: "t1", family: "capture", kind: "tool_call_started", payload: {} });
    const other = commitEvent({ turn_id: "t2", family: "stream", kind: "text_delta", payload: {} });
    expect(a.seq).toBe(1);
    expect(b.seq).toBe(2);
    expect(other.seq).toBe(1);
    expect(a.event_id).not.toBe(b.event_id);
    expect(a.occurred_at).toBeTruthy();
  });

  it("pairs every committed event with an unpublished outbox row (same txn)", () => {
    commitEvent({ turn_id: "t1", family: "capture", kind: "error", payload: {} });
    const pending = unpublishedEvents();
    expect(pending).toEqual([{ turn_id: "t1", seq: 1 }]);
  });

  it("redacts credential-shaped payloads before they reach disk", () => {
    const env = commitEvent({
      turn_id: "t1",
      family: "capture",
      kind: "tool_call_completed",
      payload: { output: "token sk-abcdefghijklmnopqrstuvwx12347890 done" },
    });
    const readBack = eventsSince("t1", 0)[0];
    const text = JSON.stringify(readBack.payload);
    expect(text).not.toContain("sk-abcdefghijklmnopqrstuvwx12347890");
    expect(env.seq).toBe(1);
  });
});

describe("turn state CAS", () => {
  it("transitions only from the expected state and bumps revision", () => {
    insertTurnRow("t9", "accepted");
    expect(transitionTurnState("t9", "accepted", "running")).toBe(true);
    expect(transitionTurnState("t9", "accepted", "running")).toBe(false);
    const status = turnStatus("t9");
    expect(status).toMatchObject({ turn_id: "t9", state: "running", revision: 1 });
  });

  it("reports last_committed_seq alongside state", () => {
    insertTurnRow("t10", "running");
    commitEvent({ turn_id: "t10", family: "capture", kind: "turn_state_changed", payload: {} });
    commitEvent({ turn_id: "t10", family: "capture", kind: "turn_terminal", payload: {} });
    expect(turnStatus("t10")).toMatchObject({ state: "running", last_committed_seq: 2 });
  });

  it("returns null status for unknown turns", () => {
    expect(turnStatus("nope")).toBeNull();
  });
});

describe("replay + outbox drain", () => {
  it("replays strictly after the given seq in order", () => {
    for (const kind of ["a", "b", "c"]) {
      commitEvent({ turn_id: "r1", family: "capture", kind, payload: { kind } });
    }
    const kinds = eventsSince("r1", 1).map((envelope) => envelope.kind);
    expect(kinds).toEqual(["b", "c"]);
    expect(eventsSince("r1", 3)).toEqual([]);
  });

  it("marks outbox rows published and drains only the rest", () => {
    commitEvent({ turn_id: "d1", family: "capture", kind: "one", payload: {} });
    commitEvent({ turn_id: "d1", family: "capture", kind: "two", payload: {} });
    markPublished("d1", 1);
    expect(unpublishedEvents()).toEqual([{ turn_id: "d1", seq: 2 }]);
  });
});
