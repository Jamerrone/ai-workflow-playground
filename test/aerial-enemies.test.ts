import { describe, it, expect } from "vitest";
import { buildRegistry, createEngine } from "../src/index.js";
import type { ConfigRegistry, GameEvent, LoaderInput } from "../src/index.js";
import { builtInBundle, enemiesPlugin } from "../src/plugins/builtin/index.js";
import { AERIAL_GRUNT, GROUND_GRUNT } from "../src/plugins/builtin/enemies.js";

// Two parallel paths — one ground, one aerial — and a slot at (2,0) on the
// ground row where the test placeable tower goes. Bases live at the far end
// of each path so enemies that reach them register at win-loss.
function buildAerialRegistry(): ConfigRegistry {
  return {
    components: {},
    entityKinds: {},
    maps: {
      m: {
        width: 20,
        height: 5,
        paths: [
          {
            id: "ground-lane",
            kind: "ground",
            waypoints: [
              { x: 0, y: 0 },
              { x: 19, y: 0 },
            ],
          },
          {
            id: "sky-lane",
            kind: "aerial",
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
        towerSlots: [{ x: 2, y: 0 }, { x: 2, y: 4 }],
        placementMode: { kind: "fixed" },
      },
    },
    towers: {
      "ground-archer": {
        cost: 10,
        attacks: [
          {
            id: "shot",
            stats: { damage: 1, range: 10, cooldown: 0.1 },
            targetFilter: { exclude: ["flying"] },
            effects: [{ kind: "damage", stats: { amount: 1 } }],
          },
        ],
      },
      "anti-air": {
        cost: 10,
        attacks: [
          {
            id: "shot",
            stats: { damage: 1, range: 10, cooldown: 0.1 },
            targetFilter: { require: ["flying"] },
            effects: [{ kind: "damage", stats: { amount: 1 } }],
          },
        ],
      },
    },
    enemies: {
      grunt: GROUND_GRUNT,
      bat: AERIAL_GRUNT,
    },
    waves: {
      ground: {
        groups: [{ id: "g", enemy: "grunt", count: 1, interval: 0, delay: 0 }],
      },
      sky: {
        groups: [{ id: "g", enemy: "bat", count: 1, interval: 0, delay: 0 }],
      },
      mixed: {
        groups: [
          { id: "g_ground", enemy: "grunt", count: 1, interval: 0, delay: 0 },
          { id: "g_sky", enemy: "bat", count: 1, interval: 0, delay: 0 },
        ],
      },
    },
    scenarios: {
      ground: {
        map: "m",
        waves: [{ id: "ground", pathBindings: { g: "ground-lane" } }],
        waveTrigger: { kind: "manual" },
        gameRuleOverrides: { globalBaseHealth: 10000, startingGold: 100 },
      },
      sky: {
        map: "m",
        waves: [{ id: "sky", pathBindings: { g: "sky-lane" } }],
        waveTrigger: { kind: "manual" },
        gameRuleOverrides: { globalBaseHealth: 10000, startingGold: 100 },
      },
      mixed: {
        map: "m",
        waves: [
          {
            id: "mixed",
            pathBindings: { g_ground: "ground-lane", g_sky: "sky-lane" },
          },
        ],
        waveTrigger: { kind: "manual" },
        gameRuleOverrides: { globalBaseHealth: 10000, startingGold: 100 },
      },
    },
    upgrades: {},
    difficulties: {},
    gameRules: {},
  };
}

function listEnemies(snap: string): Array<{
  pathId: string;
  archetype: string;
}> {
  const parsed = JSON.parse(snap) as {
    entities: Array<{ id: string; components: Record<string, unknown> }>;
  };
  return parsed.entities
    .filter((e) => e.id.startsWith("enemy:"))
    .map((e) => ({
      pathId: (e.components.pathProgress as { pathId: string }).pathId,
      archetype: (e.components.enemy as { archetype: string }).archetype,
    }));
}

describe("aerial enemies: built-in archetypes", () => {
  it("the enemies plugin ships GROUND_GRUNT and AERIAL_GRUNT archetypes", () => {
    expect(GROUND_GRUNT.tags).toContain("ground");
    expect(AERIAL_GRUNT.tags).toContain("flying");
    // Aerial enemies have their own stats — they are not just retagged ground enemies.
    expect(AERIAL_GRUNT.stats.hp).toBeTypeOf("number");
    expect(AERIAL_GRUNT.stats.speed).toBeTypeOf("number");
    expect(AERIAL_GRUNT.killReward).toBeTypeOf("number");
  });

  it("enemiesPlugin is included in the built-in bundle", () => {
    expect(builtInBundle).toContain(enemiesPlugin);
  });
});

describe("aerial enemies: Loader path-kind enforcement", () => {
  it("aerial Path bound to a flying-tagged WaveGroup passes the Loader", () => {
    const r = buildRegistry(buildAerialRegistry() as unknown as LoaderInput);
    expect(r.ok).toBe(true);
  });

  it("PATH_BINDING_TAG_MISMATCH — binding a ground enemy to an aerial path raises", () => {
    const reg = buildAerialRegistry();
    // Re-route the ground group onto the aerial path.
    (reg.scenarios as any).ground.waves[0].pathBindings = { g: "sky-lane" };
    const r = buildRegistry(reg as unknown as LoaderInput);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => e.code === "PATH_BINDING_TAG_MISMATCH")).toBe(true);
    }
  });

  it("PATH_BINDING_TAG_MISMATCH — binding a flying enemy to a ground path raises", () => {
    const reg = buildAerialRegistry();
    (reg.scenarios as any).sky.waves[0].pathBindings = { g: "ground-lane" };
    const r = buildRegistry(reg as unknown as LoaderInput);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => e.code === "PATH_BINDING_TAG_MISMATCH")).toBe(true);
    }
  });
});

describe("aerial enemies: runtime path traversal", () => {
  it("an aerial enemy walks the aerial path identically to a ground enemy on the ground path", () => {
    const reg = buildAerialRegistry();
    const engine = createEngine(reg, { plugins: builtInBundle, seed: 1 });
    engine.loadScenario("sky");
    engine.sendNextWave();
    engine.tick(0.001);
    const enemies = listEnemies(engine.snapshot());
    engine.dispose();
    expect(enemies.length).toBe(1);
    expect(enemies[0]!.pathId).toBe("sky-lane");
    expect(enemies[0]!.archetype).toBe("bat");
  });

  it("mixed wave: a single Wave sends ground and aerial Enemies down different Paths simultaneously", () => {
    const reg = buildAerialRegistry();
    const engine = createEngine(reg, { plugins: builtInBundle, seed: 2 });
    engine.loadScenario("mixed");
    engine.sendNextWave();
    engine.tick(0.001);
    const enemies = listEnemies(engine.snapshot());
    engine.dispose();
    expect(enemies).toHaveLength(2);
    const byArchetype = Object.fromEntries(enemies.map((e) => [e.archetype, e.pathId]));
    expect(byArchetype.grunt).toBe("ground-lane");
    expect(byArchetype.bat).toBe("sky-lane");
  });
});

describe("aerial enemies: targetFilter behavior (no-special-case rule)", () => {
  it("a Tower with targetFilter.exclude:['flying'] does NOT fire on aerial enemies", () => {
    const reg = buildAerialRegistry();
    // Aerial enemy walks slowly so it stays in range.
    (reg.enemies as any).bat.stats.speed = 0.001;
    const engine = createEngine(reg, { plugins: builtInBundle, seed: 3 });
    const fired: GameEvent[] = [];
    engine.on("towerFired", (e) => fired.push(e));
    engine.loadScenario("sky");
    // Place the ground-archer NEAR the sky lane (at (2, 4)) so distance is not
    // a confound — exclusion of `flying` is the only reason it should not fire.
    const placed = engine.placeTower("ground-archer", { x: 2, y: 4 });
    expect(placed.ok).toBe(true);
    engine.sendNextWave();
    for (let i = 0; i < 30; i++) engine.tick(0.1);
    engine.dispose();
    expect(fired.length).toBe(0);
  });

  it("a Tower with targetFilter.require:['flying'] fires on aerial but NOT on ground enemies", () => {
    const reg = buildAerialRegistry();
    (reg.enemies as any).bat.stats.speed = 0.001;
    (reg.enemies as any).bat.stats.hp = 10000;
    (reg.enemies as any).grunt.stats.speed = 0.001;
    (reg.enemies as any).grunt.stats.hp = 10000;
    const engine = createEngine(reg, { plugins: builtInBundle, seed: 4 });
    const fired: GameEvent[] = [];
    engine.on("towerFired", (e) => fired.push(e));
    engine.loadScenario("mixed");
    const placed = engine.placeTower("anti-air", { x: 2, y: 4 });
    expect(placed.ok).toBe(true);
    engine.sendNextWave();
    for (let i = 0; i < 30; i++) engine.tick(0.1);
    engine.dispose();
    expect(fired.length).toBeGreaterThan(0);
    // Every fire's target must be the aerial enemy (the bat). Look it up from
    // the recorded entity id format `enemy:<groupId>:...`.
    for (const e of fired) {
      const targetId = e.target as string;
      expect(targetId).toContain("g_sky");
    }
  });

  it("an unfiltered Tower fires on aerial enemies (no aerial-bypass special case)", () => {
    // The default behavior: no targetFilter on the attack => any enemy matches.
    const reg = buildAerialRegistry();
    (reg.enemies as any).bat.stats.speed = 0.001;
    (reg.enemies as any).bat.stats.hp = 100;
    (reg.towers as any)["ground-archer"].attacks[0].targetFilter = undefined;
    const engine = createEngine(reg, { plugins: builtInBundle, seed: 5 });
    const fired: GameEvent[] = [];
    engine.on("towerFired", (e) => fired.push(e));
    engine.loadScenario("sky");
    const placed = engine.placeTower("ground-archer", { x: 2, y: 4 });
    expect(placed.ok).toBe(true);
    engine.sendNextWave();
    for (let i = 0; i < 30; i++) engine.tick(0.1);
    engine.dispose();
    expect(fired.length).toBeGreaterThan(0);
  });
});

describe("aerial enemies: no regressions on ground scenarios", () => {
  it("ground enemies still traverse ground paths and damage ground bases", () => {
    const reg = buildAerialRegistry();
    (reg.enemies as any).grunt.stats.speed = 100;
    (reg.enemies as any).grunt.stats.baseDamage = 1;
    const engine = createEngine(reg, { plugins: builtInBundle, seed: 6 });
    const events: GameEvent[] = [];
    engine.on("enemyReachedBase", (e) => events.push(e));
    engine.loadScenario("ground");
    engine.sendNextWave();
    for (let i = 0; i < 30; i++) engine.tick(0.1);
    engine.dispose();
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]!.base).toBe("b1");
  });
});
