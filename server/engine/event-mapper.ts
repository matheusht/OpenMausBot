// Canonical RuntimeEvent → durable envelope mapping. Pure: no I/O, no
// clock — the caller supplies identity fields via the turn context.
//
// Mapping policy: kinds with an avenza equivalent map onto it (turn
// lifecycle → capture/turn_*, approvals → capture/pending_set_*, text →
// stream/*); anything without one maps to narrative/status carrying the
// FULL event, so the durable log stays lossless without inventing
// semantics the benchmark would later have to decode.
import type { CommitEventInput } from "./event-log.ts";
import type { RuntimeEvent } from "../contracts.ts";

/** Every field any mapping branch may put into a payload. */
interface MappedPayload {
  from?: string;
  to?: string;
  outcome?: string;
  stop_reason?: string;
  cost_usd?: number;
  usage?: { input: number; output: number };
  denials?: string[];
  session?: string;
  session_id?: string | null;
  model?: string | null;
  reason?: string;
  title?: string;
  phase?: string;
  item?: string;
  tokens?: number | null;
  text?: string;
  final?: boolean;
  delta?: string;
  stream_kind?: string;
  request_type?: string;
  tool?: string;
  summary?: string;
  choices?: string[];
  behavior?: string;
  source?: string;
  input?: number;
  output?: number;
  ok?: boolean;
  message?: string;
  setup?: boolean;
}

export function mapRuntimeEvent(event: RuntimeEvent, turnId: string): CommitEventInput {
  const mapped: CommitEventInput = { turn_id: turnId, family: "narrative", kind: "status", payload: {} };
  // SAFETY: mapped.payload was just assigned a fresh empty object literal;
  // branches below only fill documented MappedPayload fields.
  const payload = mapped.payload as MappedPayload;
  switch (event.type) {
    case "turn.started":
      mapped.family = "capture";
      mapped.kind = "turn_state_changed";
      payload.from = "accepted";
      payload.to = "running";
      return mapped;
    case "turn.completed": {
      mapped.family = "capture";
      mapped.kind = "turn_terminal";
      payload.outcome = event.ok ? "succeeded" : "failed";
      if (event.stopReason != null) payload.stop_reason = event.stopReason;
      if (event.cost != null) payload.cost_usd = event.cost;
      if (event.usage != null) payload.usage = event.usage;
      if (event.denials?.length) payload.denials = event.denials;
      return mapped;
    }
    case "session.started":
      payload.session = "started";
      if (event.sessionId != null) payload.session_id = event.sessionId;
      if (event.model != null) payload.model = event.model;
      return mapped;
    case "session.exited":
      payload.session = "exited";
      if (event.reason != null) payload.reason = event.reason;
      return mapped;
    case "item.started":
      if (event.itemType === "tool") {
        mapped.family = "capture";
        mapped.kind = "tool_call_started";
        if (event.itemId !== undefined) mapped.item_id = event.itemId;
        if (event.title != null) payload.title = event.title;
        return mapped;
      }
      mapped.family = "stream";
      mapped.kind = "reasoning_summary_delta";
      if (event.itemId !== undefined) mapped.item_id = event.itemId;
      payload.phase = "started";
      return mapped;
    case "item.updated":
      if (event.itemId !== undefined) mapped.item_id = event.itemId;
      payload.item = "updated";
      if (event.tokens != null) payload.tokens = event.tokens;
      return mapped;
    case "item.completed":
      if (event.itemType === "tool") {
        mapped.family = "capture";
        mapped.kind = "tool_call_completed";
        if (event.itemId !== undefined) mapped.item_id = event.itemId;
        payload.ok = event.ok;
        return mapped;
      }
      mapped.family = "stream";
      mapped.kind = "text_delta";
      if (event.itemId !== undefined) mapped.item_id = event.itemId;
      payload.text = event.text;
      payload.final = true;
      return mapped;
    case "content.delta":
      mapped.family = "stream";
      mapped.kind = "text_delta";
      if (event.itemId !== undefined) mapped.item_id = event.itemId;
      payload.delta = event.delta;
      payload.stream_kind = event.streamKind;
      return mapped;
    case "request.opened":
      mapped.family = "capture";
      mapped.kind = "pending_set_opened";
      if (event.requestId !== undefined) mapped.item_id = event.requestId;
      payload.request_type = event.requestType;
      payload.tool = event.tool;
      payload.summary = event.summary;
      if (event.choices?.length) payload.choices = event.choices;
      return mapped;
    case "request.resolved":
      mapped.family = "capture";
      mapped.kind = "pending_set_resolved";
      if (event.requestId !== undefined) mapped.item_id = event.requestId;
      payload.behavior = event.behavior;
      payload.source = event.source;
      return mapped;
    case "thread.token-usage.updated":
      mapped.family = "stream";
      mapped.kind = "context_usage";
      payload.input = event.input;
      payload.output = event.output;
      return mapped;
    case "runtime.error":
      mapped.family = "capture";
      mapped.kind = "error";
      payload.message = event.message;
      if (event.setup != null) payload.setup = event.setup;
      return mapped;
  }
}
