import { describe, it, expect } from "vitest";
import { createEngine, Phase } from "../src/index.js";
import type { Plugin } from "../src/index.js";
import { emptyRegistry } from "./helpers/empty-registry.js";

describe("world.query", () => {
  it("matches entities by all/any/none predicates", () => {
    let queried: {
      alive: string[];
      positioned: string[];
      eitherHealthOrDead: string[];
    } | null = null;
    const captureIds = (entities: { id: string }[]) => entities.map((e) => e.id);

    const plugin: Plugin = {
      id: "test/world-query",
      register(api) {
        api.registerComponent({ name: "position", writableIn: [Phase.Simulation] });
        api.registerComponent({ name: "health", writableIn: [Phase.Simulation] });
        api.registerComponent({ name: "dead", writableIn: [Phase.Simulation] });

        api.registerSystem({
          id: "test/seed",
          phase: Phase.Simulation,
          reads: [],
          writes: ["position", "health", "dead"],
          run(ctx) {
            if (ctx.tickIndex !== 0) return;
            ctx.world.spawn("e1", { position: { x: 1, y: 0 }, health: { hp: 10 } });
            ctx.world.spawn("e2", { position: { x: 2, y: 0 }, dead: {} });
            ctx.world.spawn("e3", { health: { hp: 5 } });
          },
        });

        api.registerSystem({
          id: "test/query",
          phase: Phase.Emit,
          reads: ["position", "health", "dead"],
          writes: [],
          after: ["test/seed"],
          run(ctx) {
            queried = {
              alive: captureIds(
                ctx.world.query({ all: ["health"], none: ["dead"] }),
              ),
              positioned: captureIds(ctx.world.query({ all: ["position"] })),
              eitherHealthOrDead: captureIds(
                ctx.world.query({ any: ["health", "dead"] }),
              ),
            };
          },
        });
      },
    };

    const engine = createEngine(emptyRegistry(), { plugins: [plugin], seed: 0 });
    engine.tick(0.1);
    engine.dispose();

    expect(queried).toEqual({
      alive: ["e1", "e3"],
      positioned: ["e1", "e2"],
      eitherHealthOrDead: ["e1", "e2", "e3"],
    });
  });
});
