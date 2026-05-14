import { describe, it, expect } from "vitest";
import { createEngine, Phase } from "../src/index.js";
import type { GameEvent, Plugin, Position, SystemContext } from "../src/index.js";
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
        width: 5,
        height: 3,
        paths: [
          {
            id: "main",
            kind: "ground",
            waypoints: [
              { x: 2, y: 1 },
              { x: 4, y: 1 },
            ],
          },
        ],
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

  it("walks each guard toward its parent Tower's rallyPoint at `speed` tiles/sec", () => {
    const samples: number[][] = [];
    const probe: Plugin = {
      id: "test/probe",
      register(api) {
        // Move the rally point on tick 0 so we observe locomotion.
        api.registerSystem({
          id: "test/move-rally",
          phase: Phase.Simulation,
          reads: ["tower", "rallyPoint"],
          writes: ["rallyPoint"],
          before: ["guards/locomotion"],
          run(ctx) {
            if (ctx.tickIndex !== 0) return;
            for (const t of ctx.world.query({ all: ["tower", "rallyPoint"] })) {
              ctx.world.mutate(t.id, "rallyPoint", () => ({ x: 5, y: 1 }));
            }
          },
        });
        api.registerSystem({
          id: "test/peek-positions",
          phase: Phase.Emit,
          reads: ["guard", "position"],
          writes: [],
          after: ["test/move-rally"],
          run(ctx) {
            const xs = ctx.world
              .query({ all: ["guard"] })
              .map((g) => (g.components.get("position") as { x: number }).x);
            samples.push(xs);
          },
        });
      },
    };

    const registry = {
      ...emptyRegistry(),
      maps: {
        m: {
          width: 7,
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
              maxCount: 1,
              respawnCooldown: 5,
              rallyPointRange: 10,
            },
          },
        },
      },
      summons: {
        "guard-footman": { hp: 10, speed: 2, idleRegen: 0, attacks: [] },
      },
      scenarios: { s: { map: "m", waves: [], waveTrigger: { kind: "manual" } } },
    };
    const engine = createEngine(registry, {
      plugins: [...builtInBundle, probe],
      seed: 0,
    });
    engine.loadScenario("s");
    engine.placeTower("barracks", { x: 1, y: 1 });

    engine.tick(1); // tick 0: rally moves to (5,1); guard at x=1, walks +2, now x=3
    engine.tick(1); // tick 1: x = 5 (arrives, clamps)
    engine.tick(1); // tick 2: stays at 5
    engine.dispose();

    expect(samples).toHaveLength(3);
    expect(samples[0]).toEqual([3]);
    expect(samples[1]).toEqual([5]);
    expect(samples[2]).toEqual([5]);
  });

  describe("unarmed wall guard", () => {
    it("a Guard with no attacks absorbs damage, dies, and never emits guardAttacked", () => {
      const events: GameEvent[] = [];
      const probe: Plugin = {
        id: "test/probe",
        register(api) {
          // Damage the guard by 4 HP per tick in Wave phase.
          api.registerSystem({
            id: "test/damage",
            phase: Phase.Wave,
            reads: ["guard", "health"],
            writes: ["health"],
            run(ctx) {
              for (const g of ctx.world.query({ all: ["guard", "health"] })) {
                const h = g.components.get("health") as { hp: number; max: number };
                ctx.world.mutate(g.id, "health", () => ({ ...h, hp: h.hp - 4 }));
              }
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
                summons: "wall-guard",
                maxCount: 1,
                respawnCooldown: 99,
                rallyPointRange: 10,
              },
            },
          },
        },
        summons: {
          "wall-guard": { hp: 10, speed: 0, idleRegen: 0, attacks: [] },
        },
        scenarios: { s: { map: "m", waves: [], waveTrigger: { kind: "manual" } } },
      };
      const engine = createEngine(registry, {
        plugins: [...builtInBundle, probe],
        seed: 0,
      });
      engine.onEvent((e) => events.push(e));
      engine.loadScenario("s");
      engine.placeTower("barracks", { x: 1, y: 1 });
      engine.tick(1); // hp 10 → 6
      engine.tick(1); // 6 → 2
      engine.tick(1); // 2 → -2 → dies
      engine.dispose();

      // Wall guard never retaliated.
      expect(events.find((e) => e.kind === "guardAttacked")).toBeUndefined();
      // Wall guard died and emitted guardDied.
      const died = events.find((e) => e.kind === "guardDied");
      expect(died).toBeDefined();
    });
  });

  describe("sell despawns guards", () => {
    it("destroys every Guard parented to a Tower when that Tower is sold", () => {
      let aliveBefore: number | null = null;
      let aliveAfter: number | null = null;
      const probe: Plugin = {
        id: "test/probe",
        register(api) {
          api.registerSystem({
            id: "test/peek-guards",
            phase: Phase.Emit,
            reads: ["guard"],
            writes: [],
            run(ctx) {
              const n = ctx.world.query({ all: ["guard"] }).length;
              if (ctx.tickIndex === 0) aliveBefore = n;
              if (ctx.tickIndex === 1) aliveAfter = n;
            },
          });
        },
      };
      const engine = setupBarracksScenario(probe);
      engine.placeTower("barracks", { x: 1, y: 1 });
      engine.tick(0); // tick 0: probe sees 3 alive
      const result = engine.sellTower("tower:barracks:1,1");
      expect(result.ok).toBe(true);
      engine.tick(0); // tick 1: probe sees 0 alive
      engine.dispose();

      expect(aliveBefore).toBe(3);
      expect(aliveAfter).toBe(0);
    });
  });

  describe("guardModifier UpgradeOp", () => {
    it("buffs every living Guard's Attack damage immediately, and new spawns inherit", () => {
      const damageEvents: GameEvent[] = [];
      const probe: Plugin = {
        id: "test/probe",
        register(api) {
          api.registerSystem({
            id: "test/inject-and-kill",
            phase: Phase.Wave,
            reads: ["guard"],
            writes: ["enemy", "position", "health"],
            run(ctx) {
              // Tick 0: inject an enemy.
              if (ctx.tickIndex === 0) {
                ctx.world.spawn("e:1", {
                  enemy: { archetype: "grunt", tags: [] },
                  position: { x: 3, y: 1 },
                  health: { hp: 100, max: 100 },
                });
              }
              // Tick 4: kill the surviving guards to force a respawn.
              if (ctx.tickIndex === 4) {
                for (const g of ctx.world.query({ all: ["guard"] })) {
                  const tower = (
                    g.components.get("parent") as { tower: string }
                  ).tower;
                  ctx.world.destroy(g.id);
                  ctx.emit({
                    kind: "guardDied",
                    tick: ctx.tickIndex,
                    guard: g.id,
                    tower,
                  });
                }
                ctx.world.destroy("e:1");
                ctx.world.spawn("e:2", {
                  enemy: { archetype: "grunt", tags: [] },
                  position: { x: 2, y: 1 },
                  health: { hp: 100, max: 100 },
                });
              }
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
            upgradeTree: ["buff"],
            components: {
              summon: {
                summons: "guard-footman",
                maxCount: 1,
                respawnCooldown: 2,
                rallyPointRange: 10,
              },
            },
          },
        },
        upgrades: {
          buff: {
            cost: 0,
            ops: [
              {
                kind: "guardModifier",
                attackId: "stab",
                effectKind: "damage",
                field: "amount",
                delta: 5,
              },
            ],
          },
        },
        summons: {
          "guard-footman": {
            hp: 10,
            speed: 0,
            idleRegen: 0,
            attacks: [
              {
                id: "stab",
                stats: { range: 5, cooldown: 1 },
                effects: [{ kind: "damage", stats: { amount: 3 } }],
              },
            ],
          },
        },
        scenarios: { s: { map: "m", waves: [], waveTrigger: { kind: "manual" } } },
      };
      const engine = createEngine(registry, {
        plugins: [...builtInBundle, probe],
        seed: 0,
      });
      engine.onEvent((e) => {
        if (e.kind === "damageApplied") damageEvents.push(e);
      });
      engine.loadScenario("s");
      engine.placeTower("barracks", { x: 1, y: 1 });
      // Purchase upgrade BEFORE first tick → buffs the living guard.
      const upRes = engine.purchaseUpgrade("tower:barracks:1,1", "buff");
      expect(upRes.ok).toBe(true);

      engine.tick(1); // tick 0: enemy injected, guard fires, expects 8 damage
      const firstDamage = damageEvents
        .filter((e) => (e as unknown as { target: string }).target === "e:1")
        .at(0);
      expect(
        (firstDamage as unknown as { amount: number } | undefined)?.amount,
      ).toBe(8);

      // Kill the guard at tick 4, advance to respawn.
      engine.tick(1); // 1
      engine.tick(1); // 2
      engine.tick(1); // 3
      engine.tick(1); // 4: kill + inject e:2
      // Respawn happens 2s later — give plenty of time.
      engine.tick(1); // 5
      engine.tick(1); // 6 — respawn fires
      engine.tick(1); // 7 — new guard engages, hits e:2 with 8 damage
      engine.dispose();

      const secondDamage = damageEvents
        .filter((e) => (e as unknown as { target: string }).target === "e:2")
        .at(0);
      expect(
        (secondDamage as unknown as { amount: number } | undefined)?.amount,
      ).toBe(8);
    });
  });

  describe("guard combat", () => {
    it("fires a Guard Attack at the engaged Enemy and applies damage", () => {
      let enemyHp: number | null = null;
      const probe: Plugin = {
        id: "test/probe",
        register(api) {
          api.registerSystem({
            id: "test/inject-enemy",
            phase: Phase.Wave,
            reads: [],
            writes: ["enemy", "position", "health"],
            run(ctx) {
              if (ctx.tickIndex !== 0) return;
              ctx.world.spawn("e:1", {
                enemy: { archetype: "grunt", tags: [] },
                position: { x: 3, y: 1 },
                health: { hp: 10, max: 10 },
              });
            },
          });
          api.registerSystem({
            id: "test/peek-enemy",
            phase: Phase.Emit,
            reads: ["enemy", "health"],
            writes: [],
            run(ctx) {
              const e = ctx.world.get("e:1");
              const h = e?.components.get("health") as { hp: number } | undefined;
              if (h) enemyHp = h.hp;
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
                maxCount: 1,
                respawnCooldown: 5,
                rallyPointRange: 10,
              },
            },
          },
        },
        summons: {
          "guard-footman": {
            hp: 10,
            speed: 0,
            idleRegen: 0,
            attacks: [
              {
                id: "stab",
                stats: { range: 5, cooldown: 1 },
                effects: [{ kind: "damage", stats: { amount: 3 } }],
              },
            ],
          },
        },
        scenarios: { s: { map: "m", waves: [], waveTrigger: { kind: "manual" } } },
      };
      const engine = createEngine(registry, {
        plugins: [...builtInBundle, probe],
        seed: 0,
      });
      engine.loadScenario("s");
      engine.placeTower("barracks", { x: 1, y: 1 });
      engine.tick(0.5); // tick 0: inject, engage, fire (cooldown 1 → fires once)
      engine.dispose();

      expect(enemyHp).toBe(7);
    });
  });

  describe("heal AttackEffect", () => {
    it("raises target HP, clamps at max, and emits entityHealed", () => {
      const captured: GameEvent[] = [];
      let observedHp: number | null = null;
      const probe: Plugin = {
        id: "test/probe",
        register(api) {
          api.registerSystem({
            id: "test/fire-heal",
            phase: Phase.Effect,
            reads: ["guard", "health"],
            writes: ["health"],
            run(ctx) {
              if (ctx.tickIndex !== 0) return;
              const heal = ctx.attackEffects.get("heal");
              if (!heal) return;
              const guards = ctx.world.query({ all: ["guard"] });
              const target = guards[0]!;
              // Damage the guard first.
              ctx.world.mutate(target.id, "health", () => ({ hp: 2, max: 10 }));
              heal.apply({
                tickIndex: ctx.tickIndex,
                dt: ctx.dt,
                world: ctx.world,
                registry: ctx.registry,
                fire: {
                  source: { id: "test/healer", position: { x: 0, y: 0 } },
                  primaryTarget: { id: target.id, position: { x: 0, y: 0 } },
                  attack: { id: "mend", stats: {} },
                  effects: [{ kind: "heal", stats: { amount: 5 } }],
                },
                effect: { kind: "heal", stats: { amount: 5 } },
                state: { targets: [target.id], abort: false },
                emit: (e: GameEvent) => captured.push(e),
              });
              observedHp = (ctx.world.get(target.id)!.components.get("health") as {
                hp: number;
              }).hp;
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
                maxCount: 1,
                respawnCooldown: 5,
                rallyPointRange: 10,
              },
            },
          },
        },
        summons: {
          "guard-footman": { hp: 10, speed: 0, idleRegen: 0, attacks: [] },
        },
        scenarios: { s: { map: "m", waves: [], waveTrigger: { kind: "manual" } } },
      };
      const engine = createEngine(registry, {
        plugins: [...builtInBundle, probe],
        seed: 0,
      });
      engine.loadScenario("s");
      engine.placeTower("barracks", { x: 1, y: 1 });
      engine.tick(0.1);
      engine.dispose();

      expect(observedHp).toBe(7);
      const healed = captured.find((e) => e.kind === "entityHealed");
      expect(healed).toBeDefined();
      expect((healed as unknown as { delta: number }).delta).toBe(5);
      expect((healed as unknown as { hp: number }).hp).toBe(7);
    });

    it("clamps a heal that would exceed max HP", () => {
      let observedHp: number | null = null;
      const probe: Plugin = {
        id: "test/probe2",
        register(api) {
          api.registerSystem({
            id: "test/fire-overheal",
            phase: Phase.Effect,
            reads: ["guard", "health"],
            writes: ["health"],
            run(ctx) {
              if (ctx.tickIndex !== 0) return;
              const heal = ctx.attackEffects.get("heal");
              if (!heal) return;
              const target = ctx.world.query({ all: ["guard"] })[0]!;
              ctx.world.mutate(target.id, "health", () => ({ hp: 8, max: 10 }));
              heal.apply({
                tickIndex: ctx.tickIndex,
                dt: ctx.dt,
                world: ctx.world,
                registry: ctx.registry,
                fire: {
                  source: { id: "x", position: { x: 0, y: 0 } },
                  primaryTarget: { id: target.id, position: { x: 0, y: 0 } },
                  attack: { id: "mend", stats: {} },
                  effects: [{ kind: "heal", stats: { amount: 5 } }],
                },
                effect: { kind: "heal", stats: { amount: 5 } },
                state: { targets: [target.id], abort: false },
                emit: () => {},
              });
              observedHp = (ctx.world.get(target.id)!.components.get("health") as {
                hp: number;
              }).hp;
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
                maxCount: 1,
                respawnCooldown: 5,
                rallyPointRange: 10,
              },
            },
          },
        },
        summons: {
          "guard-footman": { hp: 10, speed: 0, idleRegen: 0, attacks: [] },
        },
        scenarios: { s: { map: "m", waves: [], waveTrigger: { kind: "manual" } } },
      };
      const engine = createEngine(registry, {
        plugins: [...builtInBundle, probe],
        seed: 0,
      });
      engine.loadScenario("s");
      engine.placeTower("barracks", { x: 1, y: 1 });
      engine.tick(0.1);
      engine.dispose();

      expect(observedHp).toBe(10);
    });
  });

  describe("wave-clear heal", () => {
    it("full-heals every surviving Guard on waveCleared", () => {
      let healedHp: number | null = null;
      const probe: Plugin = {
        id: "test/probe",
        register(api) {
          api.registerSystem({
            id: "test/damage-then-clear",
            phase: Phase.Wave,
            reads: ["guard"],
            writes: ["health"],
            run(ctx) {
              if (ctx.tickIndex === 0) {
                for (const g of ctx.world.query({ all: ["guard"] })) {
                  ctx.world.mutate(g.id, "health", () => ({ hp: 1, max: 10 }));
                }
              }
              if (ctx.tickIndex === 1) {
                ctx.emit({ kind: "waveCleared", tick: ctx.tickIndex });
              }
            },
          });
          api.registerSystem({
            id: "test/peek-hp",
            phase: Phase.Wave,
            reads: ["guard", "health"],
            writes: [],
            run(ctx) {
              if (ctx.tickIndex !== 2) return;
              const guards = ctx.world.query({ all: ["guard"] });
              healedHp = (guards[0]?.components.get("health") as { hp: number })
                .hp;
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
                maxCount: 1,
                respawnCooldown: 5,
                rallyPointRange: 10,
              },
            },
          },
        },
        summons: {
          "guard-footman": { hp: 10, speed: 0, idleRegen: 0, attacks: [] },
        },
        scenarios: { s: { map: "m", waves: [], waveTrigger: { kind: "manual" } } },
      };
      const engine = createEngine(registry, {
        plugins: [...builtInBundle, probe],
        seed: 0,
      });
      engine.loadScenario("s");
      engine.placeTower("barracks", { x: 1, y: 1 });
      engine.tick(1); // tick 0: damage to 1
      engine.tick(1); // tick 1: waveCleared emitted → heal in flushEvents
      engine.tick(1); // tick 2: peek
      engine.dispose();

      expect(healedHp).toBe(10);
    });
  });

  describe("idle regen", () => {
    it("regenerates idleRegen HP/sec while not engaged; caps at max; pauses when engaged", () => {
      const hpSamples: number[] = [];
      const probe: Plugin = {
        id: "test/probe",
        register(api) {
          api.registerSystem({
            id: "test/damage-and-inject",
            phase: Phase.Wave,
            reads: ["guard", "health"],
            writes: ["health", "enemy", "position"],
            run(ctx) {
              if (ctx.tickIndex === 0) {
                for (const g of ctx.world.query({ all: ["guard"] })) {
                  ctx.world.mutate(g.id, "health", (h) => ({
                    ...(h as object),
                    hp: 5,
                  }));
                }
              }
              if (ctx.tickIndex === 4) {
                ctx.world.spawn("e:1", {
                  enemy: { archetype: "grunt" },
                  position: { x: 1, y: 1 },
                  health: { hp: 100, max: 100 },
                });
              }
            },
          });
          api.registerSystem({
            id: "test/peek-hp",
            phase: Phase.Emit,
            reads: ["guard", "health"],
            writes: [],
            run(ctx) {
              const guards = ctx.world.query({ all: ["guard"] });
              const hp = (guards[0]?.components.get("health") as { hp: number })?.hp;
              hpSamples.push(hp);
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
                maxCount: 1,
                respawnCooldown: 5,
                rallyPointRange: 10,
              },
            },
          },
        },
        summons: {
          "guard-footman": {
            hp: 10,
            speed: 0,
            idleRegen: 2,
            attacks: [
              {
                id: "stab",
                stats: { range: 5, cooldown: 1 },
                effects: [{ kind: "damage", stats: { amount: 1 } }],
              },
            ],
          },
        },
        scenarios: { s: { map: "m", waves: [], waveTrigger: { kind: "manual" } } },
      };
      const engine = createEngine(registry, {
        plugins: [...builtInBundle, probe],
        seed: 0,
      });
      engine.loadScenario("s");
      engine.placeTower("barracks", { x: 1, y: 1 });

      // Tick 0: damage→5 in Wave, no regen yet (Simulation runs after Wave but
      //   guard's health is 5 going in, idleRegen=2 → 7. Wait, the Wave damage
      //   happens this tick BEFORE Simulation regen.). Actually: Wave runs
      //   damage→5; Simulation runs idleRegen (no engagement) →+2=7.
      // Subsequent ticks: +2 each, capped at 10.
      engine.tick(1);
      engine.tick(1);
      engine.tick(1);
      engine.tick(1);
      engine.tick(1); // tick 4: enemy injected in Wave; engagement assigned in Sim; no regen.
      engine.tick(1); // tick 5: engaged; no regen.
      engine.dispose();

      expect(hpSamples).toEqual([7, 9, 10, 10, 10, 10]);
    });
  });

  describe("engagement + enemyEngagementCap", () => {
    it("with enemyEngagementCap=2 and 3 Guards in range of 1 Enemy, exactly 2 engage", () => {
      let engagementCounts: number | null = null;
      const probe: Plugin = {
        id: "test/probe",
        register(api) {
          // Inject 1 Enemy at (3,1) on tick 0, then sample engagement count on tick 0.
          api.registerSystem({
            id: "test/inject-enemy",
            phase: Phase.Wave,
            reads: [],
            writes: ["enemy", "position", "health"],
            run(ctx) {
              if (ctx.tickIndex !== 0) return;
              ctx.world.spawn("e:1", {
                enemy: { archetype: "grunt" },
                position: { x: 3, y: 1 },
                health: { hp: 10, max: 10 },
              });
            },
          });
          api.registerSystem({
            id: "test/peek-engagements",
            phase: Phase.Emit,
            reads: ["engagement"],
            writes: [],
            run(ctx) {
              if (ctx.tickIndex !== 0) return;
              const guards = ctx.world.query({ all: ["guard", "engagement"] });
              engagementCounts = guards.filter((g) => {
                const e = g.components.get("engagement") as
                  | { enemy?: string }
                  | undefined;
                return e?.enemy === "e:1";
              }).length;
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
                rallyPointRange: 10,
              },
            },
          },
        },
        summons: {
          "guard-footman": {
            hp: 10,
            speed: 0,
            idleRegen: 0,
            attacks: [
              {
                id: "stab",
                stats: { range: 5, cooldown: 1 },
                effects: [{ kind: "damage", stats: { amount: 1 } }],
              },
            ],
          },
        },
        scenarios: {
          s: {
            map: "m",
            waves: [],
            waveTrigger: { kind: "manual" },
            gameRuleOverrides: { enemyEngagementCap: 2 },
          },
        },
      };
      const engine = createEngine(registry, {
        plugins: [...builtInBundle, probe],
        seed: 0,
      });
      engine.loadScenario("s");
      engine.placeTower("barracks", { x: 1, y: 1 });
      engine.tick(0.1);
      engine.dispose();

      expect(engagementCounts).toBe(2);
    });
  });

  describe("moveRallyPoint action", () => {
    it("returns UNKNOWN_TOWER when the tower entity does not exist", () => {
      const engine = setupBarracksScenario();
      const result = engine.dispatch({
        kind: "moveRallyPoint",
        tower: "tower:does-not-exist",
        position: { x: 2, y: 1 },
      });
      engine.dispose();
      expect(result.ok).toBe(false);
      expect(!result.ok && result.code).toBe("UNKNOWN_TOWER");
    });

    it("returns OUT_OF_RANGE when the destination exceeds summon.rallyPointRange (Euclidean)", () => {
      const engine = setupBarracksScenario();
      engine.placeTower("barracks", { x: 1, y: 1 });
      // rallyPointRange is 4 (from setupBarracksScenario). Tower is at (1,1).
      // (1+4, 1+4) is sqrt(32) ≈ 5.66 → out of range. (1+3, 1+0) = 3 is in range.
      const far = engine.dispatch({
        kind: "moveRallyPoint",
        tower: "tower:barracks:1,1",
        position: { x: 5, y: 5 },
      });
      const near = engine.dispatch({
        kind: "moveRallyPoint",
        tower: "tower:barracks:1,1",
        position: { x: 4, y: 1 },
      });
      engine.dispose();
      expect(far.ok).toBe(false);
      expect(!far.ok && far.code).toBe("OUT_OF_RANGE");
      expect(near.ok).toBe(true);
    });

    it("returns INVALID_RALLY_TILE when the destination is a Base tile", () => {
      // Custom scenario: place a Base at (2,1) within range of the Barracks at (1,1).
      const registry = {
        ...emptyRegistry(),
        maps: {
          m: {
            width: 5,
            height: 3,
            paths: [],
            bases: [{ id: "main", position: { x: 2, y: 1 } }],
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
                maxCount: 1,
                respawnCooldown: 5,
                rallyPointRange: 4,
              },
            },
          },
        },
        scenarios: { s: { map: "m", waves: [], waveTrigger: { kind: "manual" } } },
      };
      const engine = createEngine(registry, {
        plugins: [...builtInBundle],
        seed: 0,
      });
      engine.loadScenario("s");
      engine.placeTower("barracks", { x: 1, y: 1 });

      const result = engine.dispatch({
        kind: "moveRallyPoint",
        tower: "tower:barracks:1,1",
        position: { x: 2, y: 1 }, // base tile
      });
      engine.dispose();
      expect(result.ok).toBe(false);
      expect(!result.ok && result.code).toBe("INVALID_RALLY_TILE");
    });

    it("accepts a destination on a Path tile even when not a placeable slot", () => {
      // setupBarracksScenario has a Path running (2,1)→(4,1). (3,1) is on the
      // path but not a tower slot.
      const engine = setupBarracksScenario();
      engine.placeTower("barracks", { x: 1, y: 1 });
      const result = engine.dispatch({
        kind: "moveRallyPoint",
        tower: "tower:barracks:1,1",
        position: { x: 3, y: 1 },
      });
      engine.dispose();
      expect(result.ok).toBe(true);
    });

    it("rejects a destination that is neither a Path tile nor placeable", () => {
      // (2,2) is off-path and not a slot under `fixed` mode → reject.
      const engine = setupBarracksScenario();
      engine.placeTower("barracks", { x: 1, y: 1 });
      const result = engine.dispatch({
        kind: "moveRallyPoint",
        tower: "tower:barracks:1,1",
        position: { x: 2, y: 2 },
      });
      engine.dispose();
      expect(result.ok).toBe(false);
      expect(!result.ok && result.code).toBe("INVALID_RALLY_TILE");
    });

    it("returns INVALID_RALLY_TILE when the destination is occupied by another Tower", () => {
      const registry = {
        ...emptyRegistry(),
        maps: {
          m: {
            width: 5,
            height: 3,
            paths: [],
            bases: [],
            placementMode: { kind: "fixed" },
            towerSlots: [{ x: 1, y: 1 }, { x: 3, y: 1 }],
          },
        },
        towers: {
          barracks: {
            cost: 0,
            attacks: [],
            components: {
              summon: {
                summons: "guard-footman",
                maxCount: 1,
                respawnCooldown: 5,
                rallyPointRange: 4,
              },
            },
          },
          plain: { cost: 0, attacks: [] },
        },
        scenarios: { s: { map: "m", waves: [], waveTrigger: { kind: "manual" } } },
      };
      const engine = createEngine(registry, {
        plugins: [...builtInBundle],
        seed: 0,
      });
      engine.loadScenario("s");
      engine.placeTower("barracks", { x: 1, y: 1 });
      engine.placeTower("plain", { x: 3, y: 1 });

      const result = engine.dispatch({
        kind: "moveRallyPoint",
        tower: "tower:barracks:1,1",
        position: { x: 3, y: 1 }, // occupied by the plain tower
      });
      engine.dispose();
      expect(result.ok).toBe(false);
      expect(!result.ok && result.code).toBe("INVALID_RALLY_TILE");
    });

    it("on success, updates the Tower's rallyPoint and emits rallyPointMoved", () => {
      const events: GameEvent[] = [];
      const engine = setupBarracksScenario();
      engine.onEvent((e) => events.push(e));
      engine.placeTower("barracks", { x: 1, y: 1 });

      const result = engine.dispatch({
        kind: "moveRallyPoint",
        tower: "tower:barracks:1,1",
        position: { x: 2, y: 1 },
      });
      engine.dispose();

      expect(result.ok).toBe(true);
      expect(result.ok && (result.effect as { position: Position }).position).toEqual({
        x: 2,
        y: 1,
      });
      const moved = events.find((e) => e.kind === "rallyPointMoved");
      expect(moved).toBeDefined();
      expect((moved as unknown as { tower: string }).tower).toBe("tower:barracks:1,1");
      expect((moved as unknown as { position: Position }).position).toEqual({
        x: 2,
        y: 1,
      });
    });
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
