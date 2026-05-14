import { describe, it, expect } from "vitest";
import { createEngine, Phase } from "../src/index.js";
import type { Plugin, Position } from "../src/index.js";
import { builtInBundle } from "../src/plugins/builtin/index.js";
import { emptyRegistry } from "./helpers/empty-registry.js";

describe("path-walking is decoupled from the enemy Component", () => {
  it("a plugin-defined entity with pathProgress (no enemy Component) is path-walked", () => {
    let observedPositions: Array<{ x: number; y: number }> = [];
    let baseDamagedFired = false;
    const skeletonPlugin: Plugin = {
      id: "test/skeleton",
      register(api) {
        // Skeleton archetype: carries pathProgress but NOT the `enemy` Component.
        api.registerComponent({ name: "skeleton", writableIn: [Phase.Wave] });
        api.registerEntityKind({
          kind: "skeleton",
          components: ["skeleton", "position", "pathProgress"],
        });
        api.registerSystem({
          id: "test/spawn-skeleton",
          phase: Phase.Wave,
          reads: [],
          writes: ["skeleton", "position", "pathProgress"],
          run(ctx) {
            if (ctx.tickIndex !== 0) return;
            ctx.world.spawn("s:1", {
              skeleton: {},
              position: { x: 0, y: 1 },
              pathProgress: {
                pathId: "p",
                wpIndex: 0,
                speed: 1,
                baseDamage: 0,
              },
            });
          },
        });
        api.registerSystem({
          id: "test/peek-skeleton",
          phase: Phase.Emit,
          reads: ["skeleton", "position"],
          writes: [],
          run(ctx) {
            const s = ctx.world.get("s:1");
            if (s)
              observedPositions.push(s.components.get("position") as Position);
          },
        });
      },
    };
    const registry = {
      ...emptyRegistry(),
      maps: {
        m: {
          width: 5,
          height: 3,
          paths: [
            {
              id: "p",
              kind: "ground",
              waypoints: [
                { x: 0, y: 1 },
                { x: 4, y: 1 },
              ],
            },
          ],
          bases: [{ id: "base", position: { x: 4, y: 1 } }],
          placementMode: { kind: "fixed" },
          towerSlots: [],
        },
      },
      scenarios: { s: { map: "m", waves: [], waveTrigger: { kind: "manual" } } },
    };
    const engine = createEngine(registry, {
      plugins: [...builtInBundle, skeletonPlugin],
      seed: 0,
    });
    engine.onEvent((e) => {
      if (e.kind === "baseDamaged") baseDamagedFired = true;
    });
    engine.loadScenario("s");
    engine.tick(1); // tick 0: spawn at (0,1)
    engine.tick(1); // tick 1: walked +1 → (1,1)
    engine.tick(1); // tick 2: → (2,1)
    engine.dispose();

    // Skeleton was path-walked. Spawn happens in Wave (tick 0), locomotion
    // moves it +1 in Simulation, Emit-phase peek samples post-walk → x=1
    // after tick 0, then +1 per tick.
    expect(observedPositions[0]).toEqual({ x: 1, y: 1 });
    expect(observedPositions[1]).toEqual({ x: 2, y: 1 });
    expect(observedPositions[2]).toEqual({ x: 3, y: 1 });
    // Friendly path-walker does NOT damage the base even when reaching it.
    expect(baseDamagedFired).toBe(false);
  });

  it("existing enemy path-walking still works (regression)", () => {
    // Quick sanity check that the rename/refactor doesn't break enemies.
    let enemyReachedBase = false;
    const registry = {
      ...emptyRegistry(),
      maps: {
        m: {
          width: 5,
          height: 3,
          paths: [
            {
              id: "p",
              kind: "ground",
              waypoints: [
                { x: 0, y: 1 },
                { x: 4, y: 1 },
              ],
            },
          ],
          bases: [{ id: "base", position: { x: 4, y: 1 } }],
          placementMode: { kind: "fixed" },
          towerSlots: [],
        },
      },
      enemies: {
        grunt: {
          tags: ["ground"],
          stats: { hp: 10, speed: 1, baseDamage: 1 },
          killReward: 0,
        },
      },
      waves: {
        w1: {
          groups: [
            { id: "g1", enemy: "grunt", count: 1, interval: 0, delay: 0 },
          ],
        },
      },
      scenarios: {
        s: {
          map: "m",
          waves: [
            { id: "w1", pathBindings: { g1: "p" } },
          ],
          waveTrigger: { kind: "manual" },
        },
      },
    };
    const engine = createEngine(registry, { plugins: [...builtInBundle], seed: 0 });
    engine.onEvent((e) => {
      if (e.kind === "enemyReachedBase") enemyReachedBase = true;
    });
    engine.loadScenario("s");
    engine.sendNextWave();
    for (let i = 0; i < 10; i++) engine.tick(1);
    engine.dispose();

    expect(enemyReachedBase).toBe(true);
  });
});
