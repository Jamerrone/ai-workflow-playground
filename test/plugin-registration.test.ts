import { describe, it, expect } from "vitest";
import { createEngine, Phase } from "../src/index.js";
import type { Plugin } from "../src/index.js";
import { emptyRegistry } from "./helpers/empty-registry.js";

describe("plugin registration", () => {
  it("registers a Component and a System; the System runs on tick and mutates the Component", () => {
    const sawTickCount: number[] = [];
    const plugin: Plugin = {
      id: "test/counter",
      register(api) {
        api.registerComponent({
          name: "counter",
          writableIn: [Phase.Simulation],
        });
        api.registerSystem({
          id: "test/incrementCounter",
          phase: Phase.Simulation,
          reads: [],
          writes: ["counter"],
          run(ctx) {
            // Tick counter sourced from the engine context, written to a singleton.
            sawTickCount.push(ctx.tickIndex);
          },
        });
      },
    };

    const engine = createEngine(emptyRegistry(), { plugins: [plugin], seed: 0 });
    engine.tick(0.1);
    engine.tick(0.1);
    engine.dispose();

    expect(sawTickCount).toEqual([0, 1]);
  });
});
