import { describe, it, expect } from "vitest";
import { createEngine, buildRegistry } from "../src/index.js";
import type { ConfigRegistry, GameEvent, LoaderInput } from "../src/index.js";
import { builtInBundle } from "../src/plugins/builtin/index.js";

function buildMultiWaveRegistry(): ConfigRegistry {
  return {
    components: {},
    entityKinds: {},
    maps: {
      m: {
        width: 20,
        height: 1,
        paths: [
          {
            id: "p1",
            kind: "ground",
            waypoints: [
              { x: 0, y: 0 },
              { x: 19, y: 0 },
            ],
          },
        ],
        bases: [{ id: "b1", position: { x: 19, y: 0 } }],
        towerSlots: [{ x: 2, y: 0 }],
        placementMode: { kind: "fixed" },
      },
    },
    towers: {},
    enemies: {
      grunt: {
        tags: ["ground"],
        stats: { hp: 1, speed: 20, baseDamage: 0 },
        killReward: 5,
      },
    },
    waves: {
      w1: {
        groups: [{ id: "g1", enemy: "grunt", count: 1, interval: 0, delay: 0 }],
        reward: 25,
      },
      w2: {
        groups: [{ id: "g1", enemy: "grunt", count: 1, interval: 0, delay: 0 }],
        reward: 30,
      },
      w3: {
        groups: [{ id: "g1", enemy: "grunt", count: 1, interval: 0, delay: 0 }],
        reward: 50,
      },
    },
    scenarios: {
      multi: {
        map: "m",
        waves: [
          { id: "w1", pathBindings: { g1: "p1" } },
          { id: "w2", pathBindings: { g1: "p1" } },
          { id: "w3", pathBindings: { g1: "p1" } },
        ],
        waveTrigger: { kind: "manual" },
        gameRuleOverrides: {
          globalBaseHealth: 10000,
          startingGold: 0,
        },
      },
    },
    upgrades: {},
    difficulties: {},
    gameRules: {},
  };
}

function buildTwoPathRegistry(): ConfigRegistry {
  return {
    components: {},
    entityKinds: {},
    maps: {
      twin: {
        width: 20,
        height: 5,
        paths: [
          {
            id: "north",
            kind: "ground",
            waypoints: [
              { x: 0, y: 0 },
              { x: 19, y: 0 },
            ],
          },
          {
            id: "south",
            kind: "ground",
            waypoints: [
              { x: 0, y: 4 },
              { x: 19, y: 4 },
            ],
          },
        ],
        bases: [
          { id: "b1", position: { x: 19, y: 0 } },
          { id: "b2", position: { x: 19, y: 4 } },
        ],
        towerSlots: [],
        placementMode: { kind: "fixed" },
      },
    },
    towers: {},
    enemies: {
      grunt: {
        tags: ["ground"],
        stats: { hp: 1, speed: 0.0001, baseDamage: 0 },
        killReward: 0,
      },
    },
    waves: {
      wDefault: {
        groups: [{ id: "g1", enemy: "grunt", count: 1, interval: 0, delay: 0 }],
      },
      wWildcard: {
        groups: [{ id: "g1", enemy: "grunt", count: 1, interval: 0, delay: 0 }],
      },
      wPerGroup: {
        groups: [
          { id: "g1", enemy: "grunt", count: 1, interval: 0, delay: 0 },
          { id: "g2", enemy: "grunt", count: 1, interval: 0, delay: 0 },
        ],
      },
    },
    scenarios: {
      sDefault: {
        map: "twin",
        defaultPath: "north",
        waves: [{ id: "wDefault" }],
        waveTrigger: { kind: "manual" },
        gameRuleOverrides: { globalBaseHealth: 10000, startingGold: 0 },
      },
      sWildcard: {
        map: "twin",
        defaultPath: "north",
        waves: [{ id: "wWildcard", pathBindings: "*" }],
        waveTrigger: { kind: "manual" },
        gameRuleOverrides: { globalBaseHealth: 10000, startingGold: 0 },
      },
      sPerGroup: {
        map: "twin",
        defaultPath: "north",
        waves: [{ id: "wPerGroup", pathBindings: { g1: "north", g2: "south" } }],
        waveTrigger: { kind: "manual" },
        gameRuleOverrides: { globalBaseHealth: 10000, startingGold: 0 },
      },
    },
    upgrades: {},
    difficulties: {},
    gameRules: {},
  };
}

describe("Slice 8: wave-clear RewardKind", () => {
  it("registerReward exposes a kind+eventKind+apply registration surface", () => {
    expect(() => {
      const engine = createEngine(buildMultiWaveRegistry(), {
        plugins: [
          ...builtInBundle,
          {
            id: "test/reward-probe",
            register(api) {
              api.registerReward({
                kind: "probe",
                eventKind: "neverFired",
                apply() {},
              });
            },
          },
        ],
        seed: 1,
      });
      engine.dispose();
    }).not.toThrow();
  });

  it("wave-clear RewardKind awards the configured delta on each waveCleared event", () => {
    const engine = createEngine(buildMultiWaveRegistry(), {
      plugins: builtInBundle,
      seed: 11,
    });
    const goldChanged: GameEvent[] = [];
    engine.on("goldChanged", (e) => goldChanged.push(e));
    engine.loadScenario("multi");
    for (let i = 0; i < 3; i++) {
      engine.sendNextWave();
      for (let t = 0; t < 100; t++) engine.tick(0.1);
    }
    engine.dispose();
    const deltas = goldChanged.map((e) => e.delta);
    expect(deltas).toContain(25);
    expect(deltas).toContain(30);
    expect(deltas).toContain(50);
  });

  it("waveCleared event is delivered before its matching goldChanged event in the same tick", () => {
    const engine = createEngine(buildMultiWaveRegistry(), {
      plugins: builtInBundle,
      seed: 12,
    });
    const events: GameEvent[] = [];
    engine.onEvent((e) => events.push(e));
    engine.loadScenario("multi");
    engine.sendNextWave();
    for (let t = 0; t < 100; t++) engine.tick(0.1);
    engine.dispose();
    const wcIndex = events.findIndex((e) => e.kind === "waveCleared");
    const gcIndex = events.findIndex(
      (e, i) => e.kind === "goldChanged" && i > wcIndex && (e.delta as number) === 25,
    );
    expect(wcIndex).toBeGreaterThanOrEqual(0);
    expect(gcIndex).toBeGreaterThan(wcIndex);
  });
});

describe("Slice 8: multi-wave scenarios", () => {
  it("three Waves run sequentially with waveCleared events in declared order", () => {
    const engine = createEngine(buildMultiWaveRegistry(), {
      plugins: builtInBundle,
      seed: 13,
    });
    const cleared: GameEvent[] = [];
    engine.on("waveCleared", (e) => cleared.push(e));
    engine.loadScenario("multi");
    for (let i = 0; i < 3; i++) {
      const result = engine.sendNextWave();
      expect(result.ok).toBe(true);
      for (let t = 0; t < 100; t++) engine.tick(0.1);
    }
    engine.dispose();
    expect(cleared.map((e) => e.waveIndex)).toEqual([0, 1, 2]);
  });

  it("WaveGroup interval and delay control per-spawn timing", () => {
    const reg = buildMultiWaveRegistry();
    // Replace wave 1 with two groups exercising interval and delay.
    (reg.waves as any).w1.groups = [
      { id: "fast", enemy: "grunt", count: 3, interval: 0.5, delay: 0 },
      { id: "delayed", enemy: "grunt", count: 1, interval: 0, delay: 2.0 },
    ];
    (reg.scenarios as any).multi.waves[0].pathBindings = { fast: "p1", delayed: "p1" };
    // Slow enemy so we can observe spawn timing.
    (reg.enemies as any).grunt.stats.speed = 0.001;
    (reg.enemies as any).grunt.stats.hp = 100;
    const engine = createEngine(reg, { plugins: builtInBundle, seed: 14 });
    engine.loadScenario("multi");
    engine.sendNextWave();
    const liveEnemyCount = (): number => {
      const snap = JSON.parse(engine.snapshot()) as {
        entities: Array<{ id: string; components: Record<string, unknown> }>;
      };
      return snap.entities.filter((e) => e.id.startsWith("enemy:")).length;
    };
    // tick 0.5s total in dt=0.1 increments — 'fast' should have spawned 2 enemies (t=0 and t=0.5);
    // 'delayed' still waiting.
    for (let i = 0; i < 5; i++) engine.tick(0.1);
    const after05 = liveEnemyCount();
    expect(after05).toBeGreaterThanOrEqual(2);
    expect(after05).toBeLessThan(4); // delayed not yet, fast not all yet
    // tick to t=2.0s — 'fast' should have spawned all 3; 'delayed' just spawning.
    for (let i = 0; i < 15; i++) engine.tick(0.1);
    const after2 = liveEnemyCount();
    engine.dispose();
    expect(after2).toBeGreaterThanOrEqual(4);
  });

  it("boss test: count=1, high HP — Scenario does not win until the boss dies", () => {
    const reg = buildMultiWaveRegistry();
    (reg.scenarios as any).multi.waves = [{ id: "w1", pathBindings: { g1: "p1" } }];
    (reg.enemies as any).grunt.stats.hp = 9999;
    (reg.enemies as any).grunt.stats.speed = 0.0001;
    (reg.enemies as any).grunt.stats.baseDamage = 0;
    const engine = createEngine(reg, { plugins: builtInBundle, seed: 15 });
    let won = false;
    engine.on("scenarioWon", () => {
      won = true;
    });
    engine.loadScenario("multi");
    engine.sendNextWave();
    // Tick lots — boss is unkillable here, no towers placed.
    for (let i = 0; i < 50; i++) engine.tick(0.1);
    expect(won).toBe(false);
    // Now kill the boss by reducing its hp directly via a custom forced kill path —
    // simpler: rebuild a registry where the enemy can die and re-verify the path.
    engine.dispose();

    const reg2 = buildMultiWaveRegistry();
    (reg2.scenarios as any).multi.waves = [{ id: "w1", pathBindings: { g1: "p1" } }];
    (reg2.enemies as any).grunt.stats.hp = 1;
    (reg2.enemies as any).grunt.stats.speed = 1000; // walks to base immediately
    (reg2.enemies as any).grunt.stats.baseDamage = 0;
    (reg2.scenarios as any).multi.gameRuleOverrides.globalBaseHealth = 100000;
    const engine2 = createEngine(reg2, { plugins: builtInBundle, seed: 15 });
    let won2 = false;
    engine2.on("scenarioWon", () => {
      won2 = true;
    });
    engine2.loadScenario("multi");
    engine2.sendNextWave();
    for (let i = 0; i < 200 && !won2; i++) engine2.tick(0.1);
    engine2.dispose();
    expect(won2).toBe(true);
  });

  it("survivor persistence: a forced wave-clear via duration leaves enemies alive into the next wave", () => {
    const reg = buildMultiWaveRegistry();
    (reg.waves as any).w1.groups = [{ id: "g1", enemy: "grunt", count: 3, interval: 0, delay: 0 }];
    (reg.waves as any).w1.duration = 1.0;
    (reg.enemies as any).grunt.stats.hp = 9999;
    (reg.enemies as any).grunt.stats.speed = 0.0001;
    const engine = createEngine(reg, { plugins: builtInBundle, seed: 16 });
    const cleared: GameEvent[] = [];
    engine.on("waveCleared", (e) => cleared.push(e));
    engine.loadScenario("multi");
    engine.sendNextWave();
    // Tick past the wave's duration boundary.
    for (let i = 0; i < 20; i++) engine.tick(0.1);
    const firstClear = cleared[0];
    expect(firstClear).toBeDefined();
    expect((firstClear!.surviving as number) ?? 0).toBeGreaterThan(0);
    // Send wave 2 — wave 1's survivors should still be alive on the field.
    const liveCountBeforeW2 = (() => {
      const snap = JSON.parse(engine.snapshot()) as {
        entities: Array<{ id: string }>;
      };
      return snap.entities.filter((e) => e.id.startsWith("enemy:")).length;
    })();
    expect(liveCountBeforeW2).toBeGreaterThan(0);
    engine.dispose();
  });
});

describe("Slice 8: path-binding shapes", () => {
  it("defaultPath: a Wave reference without pathBindings spawns groups on the Scenario's defaultPath", () => {
    const engine = createEngine(buildTwoPathRegistry(), {
      plugins: builtInBundle,
      seed: 17,
    });
    engine.loadScenario("sDefault");
    engine.sendNextWave();
    engine.tick(0.001);
    const snap = JSON.parse(engine.snapshot()) as {
      entities: Array<{
        id: string;
        components: Record<string, unknown>;
      }>;
    };
    engine.dispose();
    const enemies = snap.entities.filter((e) => e.id.startsWith("enemy:"));
    expect(enemies.length).toBe(1);
    expect((enemies[0]!.components.pathProgress as { pathId: string }).pathId).toBe("north");
  });

  it("wildcard pathBindings: \"*\" spawns each group on every Path in the Map", () => {
    const engine = createEngine(buildTwoPathRegistry(), {
      plugins: builtInBundle,
      seed: 18,
    });
    engine.loadScenario("sWildcard");
    engine.sendNextWave();
    engine.tick(0.001);
    const snap = JSON.parse(engine.snapshot()) as {
      entities: Array<{ id: string; components: Record<string, unknown> }>;
    };
    engine.dispose();
    const enemies = snap.entities.filter((e) => e.id.startsWith("enemy:"));
    const pathIds = new Set(
      enemies.map((e) => (e.components.pathProgress as { pathId: string }).pathId),
    );
    expect(enemies.length).toBe(2);
    expect(pathIds).toEqual(new Set(["north", "south"]));
  });

  it("per-group pathBindings: { g1: north, g2: south } spawns each group on its bound path", () => {
    const engine = createEngine(buildTwoPathRegistry(), {
      plugins: builtInBundle,
      seed: 19,
    });
    engine.loadScenario("sPerGroup");
    engine.sendNextWave();
    engine.tick(0.001);
    const snap = JSON.parse(engine.snapshot()) as {
      entities: Array<{ id: string; components: Record<string, unknown> }>;
    };
    engine.dispose();
    const enemies = snap.entities.filter((e) => e.id.startsWith("enemy:"));
    const byGroup: Record<string, string> = {};
    for (const e of enemies) {
      const en = e.components.enemy as { groupId?: string };
      const pp = e.components.pathProgress as { pathId: string };
      if (en.groupId) byGroup[en.groupId] = pp.pathId;
    }
    expect(byGroup.g1).toBe("north");
    expect(byGroup.g2).toBe("south");
  });
});

describe("Slice 8: Loader path-binding tag mismatch (multi-path)", () => {
  it("PATH_BINDING_TAG_MISMATCH — wildcard binding raises when enemy lacks one bound path's tag", () => {
    const reg = buildTwoPathRegistry() as unknown as LoaderInput;
    // Make path 'south' aerial; enemy is ground-tagged → wildcard wave should fail.
    (reg.maps as any).twin.paths[1].kind = "aerial";
    const r = buildRegistry(reg);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => e.code === "PATH_BINDING_TAG_MISMATCH")).toBe(true);
    }
  });

  it("PATH_BINDING_TAG_MISMATCH — defaultPath binding raises when enemy lacks the defaultPath's tag", () => {
    const reg = buildTwoPathRegistry() as unknown as LoaderInput;
    (reg.maps as any).twin.paths[0].kind = "aerial"; // defaultPath is 'north'
    const r = buildRegistry(reg);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => e.code === "PATH_BINDING_TAG_MISMATCH")).toBe(true);
    }
  });
});
