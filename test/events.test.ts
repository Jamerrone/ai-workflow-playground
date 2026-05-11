import { describe, it, expect } from "vitest";
import { createEngine, Phase } from "../src/index.js";
import type { Plugin, GameEvent } from "../src/index.js";
import { emptyRegistry } from "./helpers/empty-registry.js";

describe("event bus", () => {
  it("emits typed events at end-of-tick in (phase → systemId → production) order", () => {
    const stream: GameEvent[] = [];

    const plugin: Plugin = {
      id: "test/events",
      register(api) {
        api.registerSystem({
          id: "test/zEmit",
          phase: Phase.Simulation,
          reads: [],
          writes: [],
          run(ctx) {
            ctx.emit({ kind: "fromZ", tick: ctx.tickIndex, seq: 1 } as GameEvent);
            ctx.emit({ kind: "fromZ", tick: ctx.tickIndex, seq: 2 } as GameEvent);
          },
        });
        api.registerSystem({
          id: "test/aEmit",
          phase: Phase.Simulation,
          reads: [],
          writes: [],
          run(ctx) {
            ctx.emit({ kind: "fromA", tick: ctx.tickIndex } as GameEvent);
          },
        });
        api.registerSystem({
          id: "test/laterPhase",
          phase: Phase.Reward,
          reads: [],
          writes: [],
          run(ctx) {
            ctx.emit({ kind: "fromReward", tick: ctx.tickIndex } as GameEvent);
          },
        });
      },
    };

    const engine = createEngine(emptyRegistry(), { plugins: [plugin], seed: 0 });
    engine.onEvent((e) => stream.push(e));
    engine.tick(0.1);
    engine.dispose();

    expect(stream).toEqual([
      { kind: "fromA", tick: 0 },
      { kind: "fromZ", tick: 0, seq: 1 },
      { kind: "fromZ", tick: 0, seq: 2 },
      { kind: "fromReward", tick: 0 },
    ]);
  });

  it("typed engine.on(kind, handler) only fires for matching kinds", () => {
    const fromAs: GameEvent[] = [];
    const fromZs: GameEvent[] = [];

    const plugin: Plugin = {
      id: "test/typed-on",
      register(api) {
        api.registerSystem({
          id: "test/emit",
          phase: Phase.Simulation,
          reads: [],
          writes: [],
          run(ctx) {
            ctx.emit({ kind: "fromA", tick: ctx.tickIndex } as GameEvent);
            ctx.emit({ kind: "fromZ", tick: ctx.tickIndex } as GameEvent);
          },
        });
      },
    };

    const engine = createEngine(emptyRegistry(), { plugins: [plugin], seed: 0 });
    engine.on("fromA", (e) => fromAs.push(e));
    engine.on("fromZ", (e) => fromZs.push(e));
    engine.tick(0.1);
    engine.dispose();

    expect(fromAs.map((e) => e.kind)).toEqual(["fromA"]);
    expect(fromZs.map((e) => e.kind)).toEqual(["fromZ"]);
  });

  it("emits during a tick are buffered, not delivered mid-tick", () => {
    const order: string[] = [];
    const plugin: Plugin = {
      id: "test/buffer",
      register(api) {
        api.registerSystem({
          id: "test/emitter",
          phase: Phase.Simulation,
          reads: [],
          writes: [],
          run(ctx) {
            order.push("emit");
            ctx.emit({ kind: "marker", tick: ctx.tickIndex } as GameEvent);
            order.push("after-emit");
          },
        });
      },
    };

    const engine = createEngine(emptyRegistry(), { plugins: [plugin], seed: 0 });
    engine.onEvent(() => order.push("delivered"));
    engine.tick(0.1);
    engine.dispose();

    // Mid-tick: emit then continue; delivery happens only after all phases finish.
    expect(order).toEqual(["emit", "after-emit", "delivered"]);
  });
});
