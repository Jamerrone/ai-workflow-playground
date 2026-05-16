import { describe, it, expect } from "vitest";
import { createEngine, Phase } from "../src/index.js";
import type { GameEvent, GameEvents, Plugin } from "../src/index.js";
import { builtInBundle } from "../src/plugins/builtin/index.js";
import { emptyRegistry } from "./helpers/empty-registry.js";

// End-to-end coverage for issue #46: Enemies attack Guards through the unified
// `ctx.fireAttack` pipeline, with symmetric sticky engagement and the
// `enemyEngagementCap` enforced on the per-Guard axis.

function buildBarracksMap() {
  return {
    m: {
      width: 12,
      height: 3,
      paths: [
        {
          id: "main",
          kind: "ground",
          waypoints: [
            { x: 0, y: 1 },
            { x: 11, y: 1 },
          ],
        },
      ],
      bases: [{ id: "b1", position: { x: 11, y: 1 } }],
      placementMode: { kind: "fixed" },
      towerSlots: [{ x: 4, y: 1 }],
    },
  };
}

function setupScenario(extra: {
  enemies?: Record<string, unknown>;
  summons?: Record<string, unknown>;
  scenarios?: Record<string, unknown>;
  towers?: Record<string, unknown>;
  probe?: Plugin;
}) {
  const registry = {
    ...emptyRegistry(),
    maps: buildBarracksMap(),
    towers: extra.towers ?? {
      barracks: {
        cost: 0,
        attacks: [],
        components: {
          summon: {
            summons: "guard-footman",
            maxCount: 1,
            respawnCooldown: 99,
            rallyPointRange: 10,
          },
        },
      },
    },
    enemies: extra.enemies ?? {},
    summons: extra.summons ?? {
      "guard-footman": { hp: 20, speed: 0, idleRegen: 0, attacks: [] },
    },
    waves: {
      w1: {
        groups: [{ id: "g1", enemy: "swordsman", count: 1, interval: 0, delay: 0 }],
      },
    },
    scenarios: extra.scenarios ?? {
      s: {
        map: "m",
        waves: [{ id: "w1", pathBindings: { g1: "main" } }],
        waveTrigger: { kind: "manual" },
        defaultPath: "main",
      },
    },
  };
  const engine = createEngine(registry, {
    plugins: extra.probe ? [...builtInBundle, extra.probe] : [...builtInBundle],
    seed: 0,
  });
  engine.loadScenario("s");
  return engine;
}

describe("enemies attack guards via unified pipeline (issue #46)", () => {
  it("an armed Enemy halts on engagement, fires its archetype Attack at the Guard, and damages the Guard", () => {
    const events: GameEvent[] = [];
    const engine = setupScenario({
      enemies: {
        swordsman: {
          tags: ["ground"],
          stats: { hp: 50, speed: 1, baseDamage: 1 },
          killReward: 0,
          attacks: [
            {
              id: "stab",
              stats: { range: 2, cooldown: 1 },
              effects: [{ kind: "damage", stats: { amount: 4 } }],
            },
          ],
        },
      },
    });
    engine.onEvent((e) => events.push(e));
    engine.placeTower("barracks", { x: 4, y: 1 });
    engine.sendNextWave();
    for (let i = 0; i < 12; i++) engine.tick(0.5);

    const enemyAttacked = events.find((e) => e.kind === "enemyAttacked");
    expect(enemyAttacked).toBeDefined();
    expect(enemyAttacked!.guard).toMatch(/^guard:/);
    expect(enemyAttacked!.attackId).toBe("stab");
    // The unarmed wall Guard absorbs damage; armed Enemy's damage applies via attack-effects.
    const damages = events.filter(
      (e): e is GameEvents["damageApplied"] => e.kind === "damageApplied" && (e as GameEvents["damageApplied"]).target.startsWith("guard:"),
    );
    expect(damages.length).toBeGreaterThanOrEqual(1);
    engine.dispose();
  });

  it("an unarmed Enemy walks past in-range Guards (no engagement, no halt)", () => {
    const events: GameEvent[] = [];
    const engine = setupScenario({
      enemies: {
        swordsman: {
          // No attacks → unarmed enemy
          tags: ["ground"],
          stats: { hp: 50, speed: 1, baseDamage: 1 },
          killReward: 0,
        },
      },
      summons: {
        "guard-footman": { hp: 20, speed: 0, idleRegen: 0, attacks: [] },
      },
    });
    engine.onEvent((e) => events.push(e));
    engine.placeTower("barracks", { x: 4, y: 1 });
    engine.sendNextWave();
    for (let i = 0; i < 30; i++) engine.tick(0.5);

    // Unarmed enemy never engaged — no enemyAttacked event.
    expect(events.find((e) => e.kind === "enemyAttacked")).toBeUndefined();
    // Enemy walked all the way to base.
    expect(events.find((e) => e.kind === "enemyReachedBase")).toBeDefined();
    engine.dispose();
  });

  it("a wall Guard (no attacks) absorbs damage from an armed Enemy until it dies → guardDied", () => {
    const events: GameEvent[] = [];
    const engine = setupScenario({
      enemies: {
        swordsman: {
          tags: ["ground"],
          stats: { hp: 50, speed: 1, baseDamage: 1 },
          killReward: 0,
          attacks: [
            {
              id: "stab",
              stats: { range: 2, cooldown: 0.5 },
              effects: [{ kind: "damage", stats: { amount: 8 } }],
            },
          ],
        },
      },
      summons: {
        // Wall guard: low HP, no attacks
        "guard-footman": { hp: 5, speed: 0, idleRegen: 0, attacks: [] },
      },
    });
    engine.onEvent((e) => events.push(e));
    engine.placeTower("barracks", { x: 4, y: 1 });
    engine.sendNextWave();
    for (let i = 0; i < 30; i++) engine.tick(0.5);

    const guardDied = events.find((e) => e.kind === "guardDied");
    expect(guardDied).toBeDefined();
    engine.dispose();
  });

  it("enemyEngagementCap caps Enemies-per-Guard: the (cap+1)-th in-range Enemy does not engage", () => {
    let engagedEnemyCount: number | null = null;
    const injectProbe: Plugin = {
      id: "test/inject",
      register(api) {
        api.registerSystem({
          id: "test/inject-many",
          phase: Phase.Wave,
          reads: [],
          writes: ["enemy", "position", "health", "attacks", "engagement"],
          run(ctx) {
            if (ctx.tickIndex !== 0) return;
            for (let i = 0; i < 3; i++) {
              ctx.world.spawn(`e:${i}`, {
                enemy: { archetype: "swordsman", tags: ["ground"] },
                position: { x: 4 + (i + 1) * 0.1, y: 1 },
                health: { hp: 50, max: 50 },
                attacks: [
                  {
                    id: "stab",
                    stats: { range: 10, cooldown: 1 },
                    effects: [{ kind: "damage", stats: { amount: 1 } }],
                  },
                ],
                engagement: {} as { target?: string },
              });
            }
          },
        });
        api.registerSystem({
          id: "test/peek",
          phase: Phase.Emit,
          reads: ["enemy", "engagement"],
          writes: [],
          run(ctx) {
            if (ctx.tickIndex !== 0) return;
            const guards = ctx.world.query({ all: ["guard"] });
            if (guards.length === 0) return;
            const guardId = guards[0]!.id;
            const enemies = ctx.world.query({ all: ["enemy", "engagement"] });
            engagedEnemyCount = enemies.filter((e) => {
              const eng = e.components.get("engagement") as { target?: string } | undefined;
              return eng?.target === guardId;
            }).length;
          },
        });
      },
    };
    const engine = setupScenario({
      probe: injectProbe,
      summons: { "guard-footman": { hp: 9999, speed: 0, idleRegen: 0, attacks: [] } },
      scenarios: {
        s: {
          map: "m",
          waves: [],
          waveTrigger: { kind: "manual" },
          gameRuleOverrides: { enemyEngagementCap: 2 },
        },
      },
    });
    engine.placeTower("barracks", { x: 4, y: 1 });
    engine.tick(0.1);
    engine.dispose();
    expect(engagedEnemyCount).toBe(2);
  });

  it("Guard engagement is sticky: a Guard does not switch from Enemy A to closer Enemy B until A dies or leaves range", () => {
    const samples: Array<{ tick: number; target: string | undefined }> = [];
    const probe: Plugin = {
      id: "test/probe",
      register(api) {
        // Inject far enemy at tick 0; closer enemy at tick 2.
        api.registerSystem({
          id: "test/inject",
          phase: Phase.Wave,
          reads: [],
          writes: ["enemy", "position", "health"],
          run(ctx) {
            if (ctx.tickIndex === 0) {
              ctx.world.spawn("e:far", {
                enemy: { archetype: "grunt", tags: ["ground"] },
                position: { x: 5, y: 1 },
                health: { hp: 100, max: 100 },
              });
            }
            if (ctx.tickIndex === 2) {
              ctx.world.spawn("e:near", {
                enemy: { archetype: "grunt", tags: ["ground"] },
                position: { x: 4.1, y: 1 },
                health: { hp: 100, max: 100 },
              });
            }
          },
        });
        api.registerSystem({
          id: "test/peek",
          phase: Phase.Emit,
          reads: ["guard", "engagement"],
          writes: [],
          run(ctx) {
            const guard = ctx.world.query({ all: ["guard", "engagement"] })[0];
            const eng = guard?.components.get("engagement") as { target?: string } | undefined;
            samples.push({ tick: ctx.tickIndex, target: eng?.target });
          },
        });
      },
    };
    const engine = setupScenario({
      probe,
      summons: {
        "guard-footman": {
          hp: 100,
          speed: 0,
          idleRegen: 0,
          attacks: [
            {
              id: "stab",
              stats: { range: 5, cooldown: 99 }, // never re-fires within the test
              effects: [{ kind: "damage", stats: { amount: 0 } }],
            },
          ],
        },
      },
    });
    engine.placeTower("barracks", { x: 4, y: 1 });
    for (let i = 0; i < 5; i++) engine.tick(1);
    engine.dispose();
    // Tick 0: engaged with e:far. Tick 2 onward: e:near exists & is closer, but
    // sticky engagement keeps the Guard on e:far.
    expect(samples[0]?.target).toBe("e:far");
    expect(samples[2]?.target).toBe("e:far");
    expect(samples[3]?.target).toBe("e:far");
  });

  it("Guards (re-)select via the parent Tower's targeting strategy (e.g. lowest-hp)", () => {
    let chosen: string | undefined;
    const probe: Plugin = {
      id: "test/probe",
      register(api) {
        api.registerSystem({
          id: "test/inject",
          phase: Phase.Wave,
          reads: [],
          writes: ["enemy", "position", "health"],
          run(ctx) {
            if (ctx.tickIndex !== 0) return;
            ctx.world.spawn("e:hi", {
              enemy: { archetype: "grunt", tags: ["ground"] },
              position: { x: 4.1, y: 1 },
              health: { hp: 100, max: 100 },
            });
            ctx.world.spawn("e:lo", {
              enemy: { archetype: "grunt", tags: ["ground"] },
              position: { x: 5, y: 1 },
              health: { hp: 1, max: 100 },
            });
          },
        });
        api.registerSystem({
          id: "test/peek",
          phase: Phase.Emit,
          reads: ["guard", "engagement"],
          writes: [],
          run(ctx) {
            if (ctx.tickIndex !== 0) return;
            const guard = ctx.world.query({ all: ["guard", "engagement"] })[0];
            const eng = guard?.components.get("engagement") as { target?: string } | undefined;
            chosen = eng?.target;
          },
        });
      },
    };
    const engine = setupScenario({
      probe,
      towers: {
        barracks: {
          cost: 0,
          attacks: [],
          targeting: { kind: "lowest-hp" },
          components: {
            summon: {
              summons: "guard-footman",
              maxCount: 1,
              respawnCooldown: 99,
              rallyPointRange: 10,
            },
          },
        },
      },
      summons: {
        "guard-footman": {
          hp: 50,
          speed: 0,
          idleRegen: 0,
          attacks: [
            {
              id: "stab",
              stats: { range: 10, cooldown: 99 },
              effects: [{ kind: "damage", stats: { amount: 0 } }],
            },
          ],
        },
      },
    });
    engine.placeTower("barracks", { x: 4, y: 1 });
    engine.tick(0.1);
    engine.dispose();
    expect(chosen).toBe("e:lo");
  });

  it("player overrideTargeting takes effect only on re-selection — does not yank a Guard off its current engagement", () => {
    const samples: Array<string | undefined> = [];
    const probe: Plugin = {
      id: "test/probe",
      register(api) {
        api.registerSystem({
          id: "test/inject",
          phase: Phase.Wave,
          reads: [],
          writes: ["enemy", "position", "health"],
          run(ctx) {
            if (ctx.tickIndex !== 0) return;
            ctx.world.spawn("e:1", {
              enemy: { archetype: "grunt", tags: ["ground"] },
              position: { x: 4.1, y: 1 },
              health: { hp: 100, max: 100 },
            });
            ctx.world.spawn("e:2", {
              enemy: { archetype: "grunt", tags: ["ground"] },
              position: { x: 5, y: 1 },
              health: { hp: 1, max: 100 },
            });
          },
        });
        api.registerSystem({
          id: "test/peek",
          phase: Phase.Emit,
          reads: ["guard", "engagement"],
          writes: [],
          run(ctx) {
            const guard = ctx.world.query({ all: ["guard", "engagement"] })[0];
            const eng = guard?.components.get("engagement") as { target?: string } | undefined;
            samples.push(eng?.target);
          },
        });
      },
    };
    const engine = setupScenario({
      probe,
      summons: {
        "guard-footman": {
          hp: 100,
          speed: 0,
          idleRegen: 0,
          attacks: [
            {
              id: "stab",
              stats: { range: 10, cooldown: 99 },
              effects: [{ kind: "damage", stats: { amount: 0 } }],
            },
          ],
        },
      },
    });
    engine.placeTower("barracks", { x: 4, y: 1 });
    engine.tick(0.5); // tick 0: engages e:1 via default closest-to-base (e:1 is at x=4.1, e:2 at x=5 — base at x=11, so e:2 is closer to base)
    // engagement now sticky on e:2 (closer to base under default closest-to-base)
    // Switch to lowest-hp mid-engagement.
    const result = engine.overrideTargeting("tower:barracks:4,1", "lowest-hp");
    expect(result.ok).toBe(true);
    engine.tick(0.5); // tick 1: engagement still sticky — should NOT yank to lowest-hp
    engine.dispose();
    // Both samples should be the same target (sticky did not change).
    expect(samples[0]).toBe(samples[1]);
    expect(samples[0]).toBeDefined();
  });

  it("`closest` TargetingStrategy is registered and selects the Manhattan-nearest candidate to the attacker", () => {
    let chosen: string | undefined;
    const probe: Plugin = {
      id: "test/probe",
      register(api) {
        api.registerSystem({
          id: "test/inject",
          phase: Phase.Wave,
          reads: [],
          writes: ["enemy", "position", "health"],
          run(ctx) {
            if (ctx.tickIndex !== 0) return;
            // far enemy on the path is closer to base; near enemy is closer to barracks
            ctx.world.spawn("e:far-from-tower", {
              enemy: { archetype: "grunt", tags: ["ground"] },
              position: { x: 9, y: 1 },
              health: { hp: 50, max: 50 },
            });
            ctx.world.spawn("e:near-tower", {
              enemy: { archetype: "grunt", tags: ["ground"] },
              position: { x: 5, y: 1 },
              health: { hp: 50, max: 50 },
            });
          },
        });
        api.registerSystem({
          id: "test/peek",
          phase: Phase.Emit,
          reads: ["guard", "engagement"],
          writes: [],
          run(ctx) {
            if (ctx.tickIndex !== 0) return;
            const guard = ctx.world.query({ all: ["guard", "engagement"] })[0];
            const eng = guard?.components.get("engagement") as { target?: string } | undefined;
            chosen = eng?.target;
          },
        });
      },
    };
    const engine = setupScenario({
      probe,
      towers: {
        barracks: {
          cost: 0,
          attacks: [],
          targeting: { kind: "closest" },
          components: {
            summon: {
              summons: "guard-footman",
              maxCount: 1,
              respawnCooldown: 99,
              rallyPointRange: 10,
            },
          },
        },
      },
      summons: {
        "guard-footman": {
          hp: 50,
          speed: 0,
          idleRegen: 0,
          attacks: [
            {
              id: "stab",
              stats: { range: 10, cooldown: 99 },
              effects: [{ kind: "damage", stats: { amount: 0 } }],
            },
          ],
        },
      },
    });
    engine.placeTower("barracks", { x: 4, y: 1 });
    engine.tick(0.1);
    engine.dispose();
    expect(chosen).toBe("e:near-tower");
  });

  it("Guards fire one Attack per tick chosen by parent Tower's attackSelection (highest-damage)", () => {
    const damages: number[] = [];
    const probe: Plugin = {
      id: "test/probe",
      register(api) {
        api.registerSystem({
          id: "test/inject",
          phase: Phase.Wave,
          reads: [],
          writes: ["enemy", "position", "health"],
          run(ctx) {
            if (ctx.tickIndex !== 0) return;
            ctx.world.spawn("e:1", {
              enemy: { archetype: "grunt", tags: ["ground"] },
              position: { x: 4.5, y: 1 },
              health: { hp: 100, max: 100 },
            });
          },
        });
      },
    };
    const engine = setupScenario({
      probe,
      towers: {
        barracks: {
          cost: 0,
          attacks: [],
          attackSelection: { kind: "highest-damage" },
          components: {
            summon: {
              summons: "guard-footman",
              maxCount: 1,
              respawnCooldown: 99,
              rallyPointRange: 10,
            },
          },
        },
      },
      summons: {
        "guard-footman": {
          hp: 50,
          speed: 0,
          idleRegen: 0,
          attacks: [
            {
              id: "weak",
              stats: { range: 5, cooldown: 0.5 },
              effects: [{ kind: "damage", stats: { amount: 1 } }],
            },
            {
              id: "strong",
              stats: { range: 5, cooldown: 0.5 },
              effects: [{ kind: "damage", stats: { amount: 7 } }],
            },
          ],
        },
      },
    });
    engine.on("damageApplied", (e) => {
      if (e.target === "e:1") {
        damages.push(e.amount);
      }
    });
    engine.placeTower("barracks", { x: 4, y: 1 });
    engine.tick(0.5);
    engine.dispose();
    // Highest-damage selection picks `strong` even though `weak` is declared first.
    expect(damages[0]).toBe(7);
  });

  it("ctx.fireAttack is exposed on SystemContext and is the unified firing routine", () => {
    let fireAttackFn: unknown;
    const probe: Plugin = {
      id: "test/probe",
      register(api) {
        api.registerSystem({
          id: "test/inspect",
          phase: Phase.Simulation,
          reads: [],
          writes: [],
          run(ctx) {
            fireAttackFn = ctx.fireAttack;
          },
        });
      },
    };
    const engine = setupScenario({ probe });
    engine.tick(0.1);
    engine.dispose();
    expect(typeof fireAttackFn).toBe("function");
  });
});
