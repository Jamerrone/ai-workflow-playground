import { describe, it, expect } from "vitest";
import { createEngine, Phase } from "../src/index.js";
import type { Plugin } from "../src/index.js";
import { emptyRegistry } from "./helpers/empty-registry.js";

describe("phase enforcement (dev mode)", () => {
  it("throws when a System writes a Component outside the Component's writableIn phase", () => {
    const plugin: Plugin = {
      id: "test/phase-enforcement",
      register(api) {
        api.registerComponent({
          name: "health",
          writableIn: [Phase.Effect], // only writable in Effect phase
        });
        api.registerSystem({
          id: "test/seed",
          phase: Phase.Effect, // allowed phase for seeding the Component
          reads: [],
          writes: ["health"],
          run(ctx) {
            if (ctx.tickIndex === 0) ctx.world.spawn("e1", { health: { hp: 10 } });
          },
        });
        api.registerSystem({
          id: "test/illegalWrite",
          phase: Phase.Reward, // Reward is NOT in writableIn for 'health'
          reads: [],
          writes: ["health"],
          after: ["test/seed"],
          run(ctx) {
            ctx.world.mutate("e1", "health", () => ({ hp: 0 }));
          },
        });
      },
    };

    const engine = createEngine(emptyRegistry(), { plugins: [plugin], seed: 0 });
    expect(() => engine.tick(0.1)).toThrow(/writableIn|phase/i);
    engine.dispose();
  });

  it("allows a System to write a Component when its phase IS in writableIn", () => {
    const plugin: Plugin = {
      id: "test/legal-write",
      register(api) {
        api.registerComponent({
          name: "health",
          writableIn: [Phase.Effect],
        });
        api.registerSystem({
          id: "test/seed",
          phase: Phase.Effect,
          reads: [],
          writes: ["health"],
          run(ctx) {
            if (ctx.tickIndex === 0) ctx.world.spawn("e1", { health: { hp: 10 } });
          },
        });
        api.registerSystem({
          id: "test/legalWrite",
          phase: Phase.Effect,
          reads: [],
          writes: ["health"],
          after: ["test/seed"],
          run(ctx) {
            ctx.world.mutate("e1", "health", () => ({ hp: 0 }));
          },
        });
      },
    };

    const engine = createEngine(emptyRegistry(), { plugins: [plugin], seed: 0 });
    expect(() => engine.tick(0.1)).not.toThrow();
    engine.dispose();
  });
});
