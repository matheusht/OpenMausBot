// Wave planner: cycle rejection is wholesale, reads fan out ≤8 per wave,
// writes always get a solo wave, and dependents wait strictly behind their
// dependencies.
import { describe, expect, it } from "vitest";

import { planDispatch, type CallNode } from "./waves.ts";

const read = (id: string, dependencies: string[] = []): CallNode => ({ id, effect_class: "read_only", dependencies });
const write = (id: string, dependencies: string[] = []): CallNode => ({
  id,
  effect_class: "non_idempotent_write",
  dependencies,
});

const waveOf = (decisions: ReturnType<typeof planDispatch>, id: string): number => {
  for (const decision of decisions) {
    if (decision.id === id && decision.kind === "run") return decision.wave;
  }
  throw new Error(`no placement for ${id}`);
};

describe("planDispatch", () => {
  it("places independent reads in one wave up to the concurrency cap", () => {
    const nodes = Array.from({ length: 10 }, (_, i) => read(`r${i}`));
    const decisions = planDispatch(nodes);
    expect(decisions.every((d) => d.kind === "run")).toBe(true);
    const waves = nodes.map((n) => waveOf(decisions, n.id));
    expect(Math.max(...waves)).toBe(1); // 8 in wave 0, spill of 2 in wave 1
  });

  it("gives every write its own solo wave", () => {
    const decisions = planDispatch([read("a"), write("w1"), write("w2"), read("b")]);
    expect(waveOf(decisions, "w2")).toBe(waveOf(decisions, "w1") + 1);
    expect(waveOf(decisions, "a")).toBeLessThan(waveOf(decisions, "w1"));
  });

  it("holds a read behind a write it depends on", () => {
    const decisions = planDispatch([write("w"), read("r", ["w"])]);
    expect(waveOf(decisions, "r")).toBe(waveOf(decisions, "w") + 1);
  });

  it("rejects the whole batch on a dependency cycle", () => {
    const decisions = planDispatch([read("a", ["b"]), read("b", ["a"]), read("c")]);
    expect(decisions).toHaveLength(3);
    expect(decisions.every((d) => d.kind === "rejected" && d.reason === "dependency_cycle")).toBe(true);
  });

  it("ignores dependencies on unknown ids (they are external results)", () => {
    const decisions = planDispatch([read("a", ["external"])]);
    expect(waveOf(decisions, "a")).toBe(0);
  });

  it("layers diamond dependencies correctly", () => {
    //   w0
    //  /  \
    // r1    r2
    //  \  /
    //   w3
    const decisions = planDispatch([
      write("w0"),
      read("r1", ["w0"]),
      read("r2", ["w0"]),
      write("w3", ["r1", "r2"]),
    ]);
    expect(waveOf(decisions, "w0")).toBe(0);
    expect(waveOf(decisions, "r1")).toBe(1);
    expect(waveOf(decisions, "r2")).toBe(1);
    expect(waveOf(decisions, "w3")).toBe(2);
  });
});
