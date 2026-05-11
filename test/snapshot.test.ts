import { describe, it, expect } from "vitest";
import { createEngine, Phase } from "../src/index.js";
import type { Plugin } from "../src/index.js";
import { emptyRegistry } from "./helpers/empty-registry.js";

function seedWorld(plugin: Plugin) {
  const engine = createEngine(emptyRegistry(), { plugins: [plugin], seed: 42 });
  engine.tick(0.1);
  const snap = engine.snapshot();
  engine.dispose();
  return snap;
}

const positionPlugin: Plugin = {
  id: "test/snapshot",
  register(api) {
    api.registerComponent({ name: "position", writableIn: [Phase.Simulation] });
    api.registerSystem({
      id: "test/seed",
      phase: Phase.Simulation,
      reads: [],
      writes: ["position"],
      run(ctx) {
        if (ctx.tickIndex !== 0) return;
        // Insert out of id-order to prove the serializer sorts canonically.
        ctx.world.spawn("zeta", { position: { y: 2, x: 1 } });
        ctx.world.spawn("alpha", { position: { x: 0, y: 0 } });
      },
    });
  },
};

describe("snapshot", () => {
  it("produces byte-identical strings for two independent engines seeded the same way", () => {
    const a = seedWorld(positionPlugin);
    const b = seedWorld(positionPlugin);
    expect(a).toEqual(b);
    expect(typeof a).toBe("string");
  });

  it("sorts keys canonically — field order within a component does not affect output", () => {
    // Two systems writing the same logical state with different field-insertion order.
    const reorderedPlugin: Plugin = {
      id: "test/snapshot-reorder",
      register(api) {
        api.registerComponent({ name: "position", writableIn: [Phase.Simulation] });
        api.registerSystem({
          id: "test/seed",
          phase: Phase.Simulation,
          reads: [],
          writes: ["position"],
          run(ctx) {
            if (ctx.tickIndex !== 0) return;
            ctx.world.spawn("zeta", { position: { x: 1, y: 2 } }); // x first
            ctx.world.spawn("alpha", { position: { y: 0, x: 0 } }); // y first
          },
        });
      },
    };
    expect(seedWorld(positionPlugin)).toEqual(seedWorld(reorderedPlugin));
  });

  it("produces different strings for differing worlds", () => {
    const differentPlugin: Plugin = {
      id: "test/snapshot-diff",
      register(api) {
        api.registerComponent({ name: "position", writableIn: [Phase.Simulation] });
        api.registerSystem({
          id: "test/seed",
          phase: Phase.Simulation,
          reads: [],
          writes: ["position"],
          run(ctx) {
            if (ctx.tickIndex !== 0) return;
            ctx.world.spawn("alpha", { position: { x: 99, y: 99 } });
          },
        });
      },
    };
    expect(seedWorld(positionPlugin)).not.toEqual(seedWorld(differentPlugin));
  });

  it("formats numbers stably — 0 vs -0 collapse, ints stay ints", () => {
    const negZeroPlugin: Plugin = {
      id: "test/snapshot-neg-zero",
      register(api) {
        api.registerComponent({ name: "position", writableIn: [Phase.Simulation] });
        api.registerSystem({
          id: "test/seed",
          phase: Phase.Simulation,
          reads: [],
          writes: ["position"],
          run(ctx) {
            if (ctx.tickIndex !== 0) return;
            ctx.world.spawn("alpha", { position: { x: -0, y: 0 } });
          },
        });
      },
    };
    const posZeroPlugin: Plugin = {
      ...negZeroPlugin,
      id: "test/snapshot-pos-zero",
      register(api) {
        api.registerComponent({ name: "position", writableIn: [Phase.Simulation] });
        api.registerSystem({
          id: "test/seed",
          phase: Phase.Simulation,
          reads: [],
          writes: ["position"],
          run(ctx) {
            if (ctx.tickIndex !== 0) return;
            ctx.world.spawn("alpha", { position: { x: 0, y: 0 } });
          },
        });
      },
    };
    expect(seedWorld(negZeroPlugin)).toEqual(seedWorld(posZeroPlugin));
  });
});
