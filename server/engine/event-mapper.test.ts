// The mapper's contract: avenza-equivalent kinds land on their family,
// everything else stays lossless under narrative/status, and identity
// fields (item/request) ride item_id where the benchmark expects them.
import { describe, expect, it } from "vitest";

const { mapRuntimeEvent } = await import("./event-mapper.ts");

const base = {
  eventId: "e1",
  provider: "claude" as const,
  threadId: "th1",
  createdAt: "2026-08-20T00:00:00Z",
};

describe("mapRuntimeEvent", () => {
  it("maps the turn lifecycle onto capture/turn_*", () => {
    const started = mapRuntimeEvent({ ...base, type: "turn.started" }, "t1");
    expect(started).toMatchObject({ family: "capture", kind: "turn_state_changed", turn_id: "t1" });
    const done = mapRuntimeEvent({ ...base, type: "turn.completed", ok: true, cost: 0.01, usage: { input: 10, output: 5 } }, "t1");
    expect(done).toMatchObject({ family: "capture", kind: "turn_terminal", payload: { outcome: "succeeded", cost_usd: 0.01 } });
    const failed = mapRuntimeEvent({ ...base, type: "turn.completed", ok: false, stopReason: "error" }, "t1");
    expect(failed.payload).toMatchObject({ outcome: "failed", stop_reason: "error" });
  });

  it("maps approvals onto pending_set events with request ids as item_id", () => {
    const opened = mapRuntimeEvent(
      { ...base, type: "request.opened", requestType: "permission", tool: "Bash", summary: "rm -rf /tmp/x", requestId: "r-9" },
      "t1",
    );
    expect(opened).toMatchObject({ family: "capture", kind: "pending_set_opened", item_id: "r-9", payload: { tool: "Bash" } });
    const resolved = mapRuntimeEvent({ ...base, type: "request.resolved", behavior: "deny", source: "timeout", requestId: "r-9" }, "t1");
    expect(resolved).toMatchObject({ family: "capture", kind: "pending_set_resolved", item_id: "r-9", payload: { source: "timeout" } });
  });

  it("maps tool items and text streams onto capture/stream families", () => {
    const toolStart = mapRuntimeEvent({ ...base, type: "item.started", itemType: "tool", title: "Bash", itemId: "i1" }, "t1");
    expect(toolStart).toMatchObject({ family: "capture", kind: "tool_call_started", item_id: "i1" });
    const toolDone = mapRuntimeEvent({ ...base, type: "item.completed", itemType: "tool", ok: true, itemId: "i1" }, "t1");
    expect(toolDone).toMatchObject({ family: "capture", kind: "tool_call_completed", payload: { ok: true } });
    const delta = mapRuntimeEvent({ ...base, type: "content.delta", streamKind: "assistant_text", delta: "he" }, "t1");
    expect(delta).toMatchObject({ family: "stream", kind: "text_delta", payload: { delta: "he" } });
    const finalText = mapRuntimeEvent({ ...base, type: "item.completed", itemType: "assistant_text", text: "done" }, "t1");
    expect(finalText).toMatchObject({ family: "stream", kind: "text_delta", payload: { final: true } });
  });

  it("keeps kinds without an avenza equivalent lossless under narrative/status", () => {
    const updated = mapRuntimeEvent({ ...base, type: "item.updated", itemType: "reasoning", tokens: 42, itemId: "i2" }, "t1");
    expect(updated).toMatchObject({ family: "narrative", kind: "status", item_id: "i2", payload: { item: "updated", tokens: 42 } });
    const exited = mapRuntimeEvent({ ...base, type: "session.exited", reason: "done" }, "t1");
    expect(exited).toMatchObject({ family: "narrative", kind: "status", payload: { session: "exited", reason: "done" } });
  });

  it("maps usage indicators and runtime errors", () => {
    const usage = mapRuntimeEvent({ ...base, type: "thread.token-usage.updated", input: 100, output: 7 }, "t1");
    expect(usage).toMatchObject({ family: "stream", kind: "context_usage", payload: { input: 100, output: 7 } });
    const error = mapRuntimeEvent({ ...base, type: "runtime.error", message: "cli missing", setup: true }, "t1");
    expect(error).toMatchObject({ family: "capture", kind: "error", payload: { setup: true } });
  });
});
