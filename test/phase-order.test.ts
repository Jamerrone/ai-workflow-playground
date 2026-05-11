import { describe, it, expect } from "vitest";
import { createEngine, Phase, PHASE_ORDER } from "../src/index.js";
import type { Plugin } from "../src/index.js";
import { emptyRegistry } from "./helpers/empty-registry.js";

describe("tick phase ordering", () => {
  it("runs systems in the documented phase order: Wave → Simulation → Effect → Reward → Rule → Emit", () => {
    const observed: Phase[] = [];
    const plugin: Plugin = {
      id: "test/phase-order",
      register(api) {
        // Registered in reverse order to ensure the engine sorts by phase,
        // not by registration order.
        for (const phase of [...PHASE_ORDER].reverse()) {
          api.registerSystem({
            id: `test/${phase}`,
            phase,
            reads: [],
            writes: [],
            run() {
              observed.push(phase);
            },
          });
        }
      },
    };
    const engine = createEngine(emptyRegistry(), { plugins: [plugin], seed: 0 });
    engine.tick(0.1);
    engine.dispose();
    expect(observed).toEqual([
      Phase.Wave,
      Phase.Simulation,
      Phase.Effect,
      Phase.Reward,
      Phase.Rule,
      Phase.Emit,
    ]);
  });
});
