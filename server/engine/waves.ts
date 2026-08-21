// Wave-batched dispatch planner — ported from avenza
// tool-loop/dispatch-scheduler.ts (ADR 0003). Pure: takes the tool calls
// the model asked for, returns which wave each runs in.
//
// Rules (unchanged from avenza):
//   - a dependency cycle rejects the WHOLE batch — a plan that can't be
//     totally ordered must not run partially
//   - reads fan out, at most MAX_CONCURRENT_READS per wave; overflow spills
//     to later waves
//   - writes are isolated: a wave is either "up to 8 reads" or "exactly one
//     write" — two mutations never race, and no read observes a write from
//     its own wave
export type EffectClass = "read_only" | "idempotent_write" | "non_idempotent_write";

export interface CallNode {
  id: string;
  effect_class: EffectClass;
  /** ids of nodes whose results this call needs */
  dependencies: string[];
}

export type DispatchDecision =
  | { id: string; kind: "rejected"; reason: "dependency_cycle" }
  | { id: string; kind: "run"; wave: number };

const MAX_CONCURRENT_READS = 8;

function hasCycle(nodes: Map<string, CallNode>): boolean {
  // DFS three-color: grey = on stack, black = done.
  const color = new Map<string, "white" | "grey" | "black">();
  const visit = (id: string): boolean => {
    const state = color.get(id) ?? "white";
    if (state === "grey") return true;
    if (state === "black") return false;
    color.set(id, "grey");
    for (const dep of nodes.get(id)?.dependencies ?? []) {
      if (nodes.has(dep) && visit(dep)) return true;
    }
    color.set(id, "black");
    return false;
  };
  for (const id of nodes.keys()) {
    if (visit(id)) return true;
  }
  return false;
}

export function planDispatch(nodes: CallNode[]): DispatchDecision[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  if (hasCycle(byId)) {
    return nodes.map((node) => ({ id: node.id, kind: "rejected", reason: "dependency_cycle" }) as const);
  }

  const waveOf = new Map<string, number>();
  const isWrite = (node: CallNode): boolean => node.effect_class !== "read_only";
  // A node is placeable once every dependency already sits in an earlier wave.
  const pending = nodes.filter((node) => !waveOf.has(node.id));
  let wave = 0;
  while (pending.length > 0) {
    const ready = pending.filter((node) =>
      node.dependencies.every((dep) => !byId.has(dep) || (waveOf.get(dep) ?? Infinity) < wave),
    );
    if (ready.length === 0) {
      // Unreachable with an acyclic graph, but fail closed rather than spin.
      break;
    }
    const writes = ready.filter(isWrite);
    const reads = ready.filter((node) => !isWrite(node));
    if (reads.length > 0) {
      // Reads fill their wave first — fan-out is the whole point of
      // batching, and an independent write never starves it.
      for (const node of reads.slice(0, MAX_CONCURRENT_READS)) waveOf.set(node.id, wave);
    } else {
      // Solo-write wave: exactly one mutation.
      waveOf.set(writes[0].id, wave);
    }
    wave += 1;
    pending.splice(0, pending.length, ...pending.filter((node) => !waveOf.has(node.id)));
  }

  return nodes.map((node) => {
    const placed = waveOf.get(node.id);
    return placed === undefined
      ? ({ id: node.id, kind: "rejected", reason: "dependency_cycle" } as const)
      : ({ id: node.id, kind: "run", wave: placed } as const);
  });
}
