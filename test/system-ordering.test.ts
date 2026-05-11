import { describe, it, expect } from "vitest";
import { createEngine, Phase } from "../src/index.js";
import type { Plugin, SystemDef } from "../src/index.js";
import { emptyRegistry } from "./helpers/empty-registry.js";

function runOrder(systems: SystemDef[]): string[] {
  const observed: string[] = [];
  const wrapped = systems.map((s) => ({
    ...s,
    run() {
      observed.push(s.id);
    },
  }));
  const plugin: Plugin = {
    id: "test/order",
    register(api) {
      for (const s of wrapped) api.registerSystem(s);
    },
  };
  const engine = createEngine(emptyRegistry(), { plugins: [plugin], seed: 0 });
  engine.tick(0.1);
  engine.dispose();
  return observed;
}

describe("intra-phase system ordering", () => {
  it("respects before/after declarations", () => {
    const observed = runOrder([
      {
        id: "p/b",
        phase: Phase.Simulation,
        reads: [],
        writes: [],
        after: ["p/a"],
        run() {},
      },
      {
        id: "p/a",
        phase: Phase.Simulation,
        reads: [],
        writes: [],
        before: ["p/c"],
        run() {},
      },
      {
        id: "p/c",
        phase: Phase.Simulation,
        reads: [],
        writes: [],
        run() {},
      },
    ]);
    expect(observed).toEqual(["p/a", "p/b", "p/c"]);
  });

  it("ties break by stable id ascending, not registration order", () => {
    // Registered b, c, a — should still run a, b, c (id ascending).
    const observed = runOrder([
      { id: "p/b", phase: Phase.Simulation, reads: [], writes: [], run() {} },
      { id: "p/c", phase: Phase.Simulation, reads: [], writes: [], run() {} },
      { id: "p/a", phase: Phase.Simulation, reads: [], writes: [], run() {} },
    ]);
    expect(observed).toEqual(["p/a", "p/b", "p/c"]);
  });

  it("throws on a contradictory ordering cycle", () => {
    const plugin: Plugin = {
      id: "test/cycle",
      register(api) {
        api.registerSystem({
          id: "p/x",
          phase: Phase.Simulation,
          reads: [],
          writes: [],
          before: ["p/y"],
          run() {},
        });
        api.registerSystem({
          id: "p/y",
          phase: Phase.Simulation,
          reads: [],
          writes: [],
          before: ["p/x"],
          run() {},
        });
      },
    };
    expect(() =>
      createEngine(emptyRegistry(), { plugins: [plugin], seed: 0 }),
    ).toThrow(/cycle/i);
  });
});
