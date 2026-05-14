import { describe, it, expect } from "vitest";
import { createEngine, Phase } from "../src/index.js";
import type { Plugin, SystemContext } from "../src/index.js";
import { builtInBundle } from "../src/plugins/builtin/index.js";
import { emptyRegistry } from "./helpers/empty-registry.js";

function setupEngine(probe: Plugin) {
  const registry = {
    ...emptyRegistry(),
    maps: {
      m: { width: 1, height: 1, paths: [], bases: [], placementMode: { kind: "fixed" } },
    },
    scenarios: { s: { map: "m", waves: [], waveTrigger: { kind: "manual" } } },
  };
  const engine = createEngine(registry, {
    plugins: [...builtInBundle, probe],
    seed: 0,
  });
  engine.loadScenario("s");
  return engine;
}

function setupBarracksScenario(probe?: Plugin) {
  const registry = {
    ...emptyRegistry(),
    maps: {
      m: {
        width: 3,
        height: 3,
        paths: [],
        bases: [],
        placementMode: { kind: "fixed" },
        towerSlots: [{ x: 1, y: 1 }],
      },
    },
    towers: {
      barracks: {
        cost: 0,
        attacks: [],
        components: {
          summon: {
            summons: "guard-footman",
            maxCount: 3,
            respawnCooldown: 5,
            rallyPointRange: 4,
          },
        },
      },
    },
    scenarios: {
      s: {
        map: "m",
        waves: [],
        waveTrigger: { kind: "manual" },
        gameRuleOverrides: { startingGold: 0 },
      },
    },
  };
  const engine = createEngine(registry, {
    plugins: probe ? [...builtInBundle, probe] : [...builtInBundle],
    seed: 0,
  });
  engine.loadScenario("s");
  return engine;
}

describe("guards plugin: skeleton", () => {
  it("registers the `guard` EntityKind with summon, rallyPoint, parent, health, position", () => {
    let captured: SystemContext | null = null;
    const probe: Plugin = {
      id: "test/probe",
      register(api) {
        api.registerSystem({
          id: "test/peek",
          phase: Phase.Simulation,
          reads: [],
          writes: [],
          run(ctx) {
            captured = ctx;
          },
        });
      },
    };
    const engine = setupEngine(probe);
    engine.tick(0.1);
    engine.dispose();

    const guard = captured!.entityKinds.get("guard");
    expect(guard).toBeDefined();
    expect(guard!.components).toEqual(
      expect.arrayContaining(["guard", "position", "health", "rallyPoint", "parent"]),
    );
  });

  it("spawns maxCount guards at the Tower's position the moment a Barracks is placed", () => {
    let snapshot: { id: string; pos: unknown; parent: unknown }[] = [];
    const probe: Plugin = {
      id: "test/probe",
      register(api) {
        api.registerSystem({
          id: "test/peek",
          phase: Phase.Emit,
          reads: ["guard", "position", "parent"],
          writes: [],
          run(ctx) {
            snapshot = ctx.world.query({ all: ["guard"] }).map((e) => ({
              id: e.id,
              pos: e.components.get("position"),
              parent: e.components.get("parent"),
            }));
          },
        });
      },
    };
    const engine = setupBarracksScenario(probe);
    const result = engine.placeTower("barracks", { x: 1, y: 1 });
    expect(result.ok).toBe(true);
    engine.tick(0); // run probe
    engine.dispose();

    expect(snapshot).toHaveLength(3);
    for (const g of snapshot) {
      expect(g.pos).toEqual({ x: 1, y: 1 });
      expect((g.parent as { tower: string }).tower).toBe(
        "tower:barracks:1,1",
      );
    }
  });

  it("respawns dead guards one-per-respawnCooldown, never in parallel", () => {
    const tickCounts: number[] = [];
    const probe: Plugin = {
      id: "test/probe",
      register(api) {
        api.registerSystem({
          id: "test/peek",
          phase: Phase.Emit,
          reads: ["guard"],
          writes: [],
          run(ctx) {
            tickCounts.push(ctx.world.query({ all: ["guard"] }).length);
          },
        });
      },
    };
    const engine = setupBarracksScenario(probe);
    engine.placeTower("barracks", { x: 1, y: 1 });
    engine.tick(0); // probe sees initial 3
    expect(tickCounts.at(-1)).toBe(3);

    // Kill all three guards simultaneously via destroy.
    // Simulate by emitting guardDied and destroying — handled by a tester-side
    // hook. We do it through a tiny ad-hoc System the next tick.
    let killed = false;
    const killer: Plugin = {
      id: "test/killer",
      register(killApi) {
        killApi.registerSystem({
          id: "test/kill",
          phase: Phase.Simulation,
          reads: ["guard"],
          writes: [],
          run(ctx) {
            if (killed) return;
            killed = true;
            for (const g of ctx.world.query({ all: ["guard"] })) {
              ctx.world.destroy(g.id);
              ctx.emit({
                kind: "guardDied",
                tick: ctx.tickIndex,
                guard: g.id,
                tower: (g.components.get("parent") as { tower: string }).tower,
              });
            }
          },
        });
      },
    };
    engine.dispose();

    // Rebuild with both probes since the engine is one-shot configured.
    const engine2 = (() => {
      const registry = {
        ...emptyRegistry(),
        maps: {
          m: {
            width: 3,
            height: 3,
            paths: [],
            bases: [],
            placementMode: { kind: "fixed" },
            towerSlots: [{ x: 1, y: 1 }],
          },
        },
        towers: {
          barracks: {
            cost: 0,
            attacks: [],
            components: {
              summon: {
                summons: "guard-footman",
                maxCount: 3,
                respawnCooldown: 5,
                rallyPointRange: 4,
              },
            },
          },
        },
        scenarios: { s: { map: "m", waves: [], waveTrigger: { kind: "manual" } } },
      };
      return createEngine(registry, {
        plugins: [...builtInBundle, probe, killer],
        seed: 0,
      });
    })();
    tickCounts.length = 0;
    engine2.loadScenario("s");
    engine2.placeTower("barracks", { x: 1, y: 1 });

    // Tick 0: killer destroys all 3. Probe sees 0 after kill.
    engine2.tick(1);
    expect(tickCounts.at(-1)).toBe(0);

    // No respawns until 5s of dt elapses (respawnCooldown).
    engine2.tick(2);
    expect(tickCounts.at(-1)).toBe(0);
    engine2.tick(2);
    expect(tickCounts.at(-1)).toBe(0);
    engine2.tick(1); // total elapsed since kill = 1+2+2+1 = 6 ≥ 5 → 1 guard respawns
    expect(tickCounts.at(-1)).toBe(1);

    // Next 5s → 2nd respawn.
    engine2.tick(5);
    expect(tickCounts.at(-1)).toBe(2);

    // Next 5s → 3rd respawn.
    engine2.tick(5);
    expect(tickCounts.at(-1)).toBe(3);

    engine2.dispose();
  });

  it("registers `summon` Component (config attached to Tower archetypes)", () => {
    let captured: SystemContext | null = null;
    const probe: Plugin = {
      id: "test/probe",
      register(api) {
        api.registerSystem({
          id: "test/peek",
          phase: Phase.Simulation,
          reads: ["summon"],
          writes: [],
          run(ctx) {
            captured = ctx;
          },
        });
      },
    };
    const engine = setupEngine(probe);
    engine.tick(0.1);
    engine.dispose();

    // If `summon` weren't registered, the kernel's reads-declaration enforcement
    // or the EntityKind→Component check would fail elsewhere. Reaching here
    // without throwing is the green signal.
    expect(captured).not.toBeNull();
  });
});
