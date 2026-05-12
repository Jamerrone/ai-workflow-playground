import { describe, it, expect } from "vitest";
import { buildRegistry, createEngine } from "../src/index.js";
import type { ConfigRegistry, GameEvent, LoaderInput } from "../src/index.js";
import { builtInBundle } from "../src/plugins/builtin/index.js";
import { buildTracerRegistry } from "./helpers/tracer-registry.js";

function validated(reg: ConfigRegistry): ConfigRegistry {
  const r = buildRegistry(reg as unknown as LoaderInput);
  if (!r.ok) throw new Error(`registry invalid: ${JSON.stringify(r.errors)}`);
  return r.registry;
}

function multiEnemyRegistry(): ConfigRegistry {
  // Map: 0..6 along y=0. Slot at x=3, base at x=6. Three enemies along the path
  // give the strategies a real choice.
  const reg = buildTracerRegistry();
  (reg.maps as any)["tracer-map"] = {
    width: 7,
    height: 1,
    paths: [
      {
        id: "p1",
        kind: "ground",
        waypoints: [
          { x: 0, y: 0 },
          { x: 6, y: 0 },
        ],
      },
    ],
    bases: [{ id: "b1", position: { x: 6, y: 0 } }],
    towerSlots: [{ x: 3, y: 0 }],
    placementMode: { kind: "fixed" },
  };
  // Archer with long range so every enemy is in range.
  (reg.towers as any).archer.attacks[0].stats.range = 10;
  (reg.towers as any).archer.attacks[0].stats.damage = 1; // never one-shot
  (reg.towers as any).archer.attacks[0].effects = [{ kind: "damage", stats: { amount: 1 } }];
  // Stop enemies before they reach the base so the tower has time to fire.
  (reg.enemies as any).grunt.stats.speed = 0;
  (reg.enemies as any).grunt.stats.hp = 100;
  return reg;
}

function spawnTrio(reg: ConfigRegistry, tags: Record<string, readonly string[]> = {}): void {
  // We avoid running the wave system: instead place the enemies directly via three
  // archetypes the wave plugin then spawns through a single wave with three groups.
  // Easier: define three enemy archetypes (a, b, c) and a wave that spawns one of each.
  (reg.enemies as any).a = {
    tags: ["ground", ...(tags.a ?? [])],
    stats: { hp: 30, speed: 0, baseDamage: 0 },
    killReward: 0,
  };
  (reg.enemies as any).b = {
    tags: ["ground", ...(tags.b ?? [])],
    stats: { hp: 60, speed: 0, baseDamage: 0 },
    killReward: 0,
  };
  (reg.enemies as any).c = {
    tags: ["ground", ...(tags.c ?? [])],
    stats: { hp: 10, speed: 0, baseDamage: 0 },
    killReward: 0,
  };
  (reg.waves as any).w1 = {
    groups: [
      { id: "ga", enemy: "a", count: 1, interval: 0, delay: 0 },
      { id: "gb", enemy: "b", count: 1, interval: 0, delay: 0 },
      { id: "gc", enemy: "c", count: 1, interval: 0, delay: 0 },
    ],
  };
  (reg.scenarios as any).tracer.waves = [
    { id: "w1", pathBindings: { ga: "p1", gb: "p1", gc: "p1" } },
  ];
}

function firstTargetForStrategy(
  strategy: unknown,
  setup: (reg: ConfigRegistry) => void = () => {},
): string {
  const reg = multiEnemyRegistry();
  spawnTrio(reg);
  (reg.towers as any).archer.targeting = strategy;
  setup(reg);
  const engine = createEngine(reg, { plugins: builtInBundle, seed: 11 });
  const fires: GameEvent[] = [];
  engine.on("towerFired", (e) => fires.push(e));
  engine.loadScenario("tracer");
  engine.placeTower("archer", { x: 3, y: 0 });
  engine.sendNextWave();
  // One spawn tick + one fire tick is plenty since enemies spawn together.
  for (let i = 0; i < 3 && fires.length === 0; i++) engine.tick(0.1);
  engine.dispose();
  expect(fires.length).toBeGreaterThan(0);
  return fires[0]!.target as string;
}

describe("targeting strategies — full set", () => {
  describe("closest-to-base", () => {
    it("picks the enemy nearest the base when multiple are in range", () => {
      // Move enemy 'a' closer to the base by giving it more progress.
      // All three spawn at (0,0) on a flat path, so closest = the one that walked furthest.
      // With speed 0, all are at (0,0) — closest is determined by insertion order tie-break.
      // Make it concrete by manually placing distinct positions via the wave plugin: keep
      // the first wave's spawn distinct via interval so each spawns at a different tick.
      // Simpler: assert the strategy picks SOMEONE (the test below covers ordering).
      const reg = multiEnemyRegistry();
      spawnTrio(reg);
      (reg.towers as any).archer.targeting = { kind: "closest-to-base" };
      // Make 'a' faster so it gets closer to the base.
      (reg.enemies as any).a.stats.speed = 1;
      const engine = createEngine(reg, { plugins: builtInBundle, seed: 1 });
      const fires: GameEvent[] = [];
      engine.on("towerFired", (e) => fires.push(e));
      engine.loadScenario("tracer");
      engine.placeTower("archer", { x: 3, y: 0 });
      engine.sendNextWave();
      for (let i = 0; i < 4 && fires.length === 0; i++) engine.tick(0.1);
      engine.dispose();
      expect(fires[0]!.target).toMatch(/^enemy:ga:/);
    });
  });

  describe("lowest-hp", () => {
    it("targets the enemy with the lowest current hp", () => {
      const target = firstTargetForStrategy({ kind: "lowest-hp" });
      // 'c' has hp: 10 (lowest).
      expect(target).toMatch(/^enemy:gc:/);
    });
  });

  describe("highest-hp", () => {
    it("targets the enemy with the highest current hp", () => {
      const target = firstTargetForStrategy({ kind: "highest-hp" });
      // 'b' has hp: 60 (highest).
      expect(target).toMatch(/^enemy:gb:/);
    });
  });

  describe("tag-priority", () => {
    it("targets the first enemy matching the highest-priority tag", () => {
      const reg = multiEnemyRegistry();
      spawnTrio(reg, { b: ["boss"] });
      (reg.towers as any).archer.targeting = {
        kind: "tag-priority",
        priority: ["boss", "armored"],
      };
      const engine = createEngine(reg, { plugins: builtInBundle, seed: 2 });
      const fires: GameEvent[] = [];
      engine.on("towerFired", (e) => fires.push(e));
      engine.loadScenario("tracer");
      engine.placeTower("archer", { x: 3, y: 0 });
      engine.sendNextWave();
      for (let i = 0; i < 4 && fires.length === 0; i++) engine.tick(0.1);
      engine.dispose();
      expect(fires[0]!.target).toMatch(/^enemy:gb:/);
    });

    it("walks the priority list and picks the next matching tag if the first is unmatched", () => {
      const reg = multiEnemyRegistry();
      spawnTrio(reg, { c: ["armored"] });
      (reg.towers as any).archer.targeting = {
        kind: "tag-priority",
        priority: ["boss", "armored"],
      };
      const engine = createEngine(reg, { plugins: builtInBundle, seed: 3 });
      const fires: GameEvent[] = [];
      engine.on("towerFired", (e) => fires.push(e));
      engine.loadScenario("tracer");
      engine.placeTower("archer", { x: 3, y: 0 });
      engine.sendNextWave();
      for (let i = 0; i < 4 && fires.length === 0; i++) engine.tick(0.1);
      engine.dispose();
      // 'boss' matches nothing; 'armored' matches 'c'.
      expect(fires[0]!.target).toMatch(/^enemy:gc:/);
    });

    it("breaks ties on the highest-priority tag by closest-to-base", () => {
      const reg = multiEnemyRegistry();
      spawnTrio(reg, { a: ["boss"], b: ["boss"] });
      (reg.towers as any).archer.targeting = {
        kind: "tag-priority",
        priority: ["boss"],
      };
      // Give 'a' speed so it walks ahead of 'b'.
      (reg.enemies as any).a.stats.speed = 1;
      const engine = createEngine(reg, { plugins: builtInBundle, seed: 4 });
      const fires: GameEvent[] = [];
      engine.on("towerFired", (e) => fires.push(e));
      engine.loadScenario("tracer");
      engine.placeTower("archer", { x: 3, y: 0 });
      engine.sendNextWave();
      for (let i = 0; i < 4 && fires.length === 0; i++) engine.tick(0.1);
      engine.dispose();
      expect(fires[0]!.target).toMatch(/^enemy:ga:/);
    });
  });

  describe("string-shorthand normalisation", () => {
    it("string strategy produces identical first-fire target as object form", () => {
      const reg1 = multiEnemyRegistry();
      spawnTrio(reg1);
      (reg1.towers as any).archer.targeting = { kind: "lowest-hp" };
      const e1 = createEngine(reg1, { plugins: builtInBundle, seed: 9 });
      const fires1: GameEvent[] = [];
      e1.on("towerFired", (e) => fires1.push(e));
      e1.loadScenario("tracer");
      e1.placeTower("archer", { x: 3, y: 0 });
      e1.sendNextWave();
      for (let i = 0; i < 4 && fires1.length === 0; i++) e1.tick(0.1);
      e1.dispose();

      const reg2 = multiEnemyRegistry();
      spawnTrio(reg2);
      (reg2.towers as any).archer.targeting = "lowest-hp"; // string shorthand
      const e2 = createEngine(validated(reg2), { plugins: builtInBundle, seed: 9 });
      const fires2: GameEvent[] = [];
      e2.on("towerFired", (e) => fires2.push(e));
      e2.loadScenario("tracer");
      e2.placeTower("archer", { x: 3, y: 0 });
      e2.sendNextWave();
      for (let i = 0; i < 4 && fires2.length === 0; i++) e2.tick(0.1);
      e2.dispose();

      expect(fires1[0]!.target).toBe(fires2[0]!.target);
    });
  });

  describe("three strategies, one scenario tick", () => {
    it("three towers with three different strategies pick three distinct targets from the same eligible set", () => {
      // Three slots, one tower per slot, each with a different strategy.
      const reg = multiEnemyRegistry();
      spawnTrio(reg);
      (reg.maps as any)["tracer-map"].towerSlots = [
        { x: 3, y: 0 },
        { x: 4, y: 0 },
        { x: 5, y: 0 },
      ];
      // Three tower archetypes with three different strategies, all otherwise identical.
      const baseAttack = (reg.towers as any).archer.attacks;
      (reg.towers as any).closest = {
        cost: 0,
        targeting: { kind: "closest-to-base" },
        attacks: baseAttack,
      };
      (reg.towers as any).lowest = {
        cost: 0,
        targeting: { kind: "lowest-hp" },
        attacks: baseAttack,
      };
      (reg.towers as any).highest = {
        cost: 0,
        targeting: { kind: "highest-hp" },
        attacks: baseAttack,
      };
      // Give 'a' speed so it gets closest to the base.
      (reg.enemies as any).a.stats.speed = 1;
      const engine = createEngine(reg, { plugins: builtInBundle, seed: 12 });
      const fires: GameEvent[] = [];
      engine.on("towerFired", (e) => fires.push(e));
      engine.loadScenario("tracer");
      engine.placeTower("closest", { x: 3, y: 0 });
      engine.placeTower("lowest", { x: 4, y: 0 });
      engine.placeTower("highest", { x: 5, y: 0 });
      engine.sendNextWave();
      for (let i = 0; i < 6 && fires.length < 3; i++) engine.tick(0.1);
      engine.dispose();
      expect(fires.length).toBeGreaterThanOrEqual(3);
      const bySource = new Map(fires.slice(0, 3).map((f) => [f.source, f.target]));
      const closestTarget = bySource.get("tower:closest:3,0");
      const lowestTarget = bySource.get("tower:lowest:4,0");
      const highestTarget = bySource.get("tower:highest:5,0");
      expect(closestTarget).toMatch(/^enemy:ga:/);
      expect(lowestTarget).toMatch(/^enemy:gc:/);
      expect(highestTarget).toMatch(/^enemy:gb:/);
      const distinct = new Set([closestTarget, lowestTarget, highestTarget]);
      expect(distinct.size).toBe(3);
    });
  });

  describe("default + unknown kinds", () => {
    it("falls back to closest-to-base when the tower has no targeting field", () => {
      const reg = multiEnemyRegistry();
      spawnTrio(reg);
      delete (reg.towers as any).archer.targeting;
      (reg.enemies as any).a.stats.speed = 1;
      const engine = createEngine(reg, { plugins: builtInBundle, seed: 1 });
      const fires: GameEvent[] = [];
      engine.on("towerFired", (e) => fires.push(e));
      engine.loadScenario("tracer");
      engine.placeTower("archer", { x: 3, y: 0 });
      engine.sendNextWave();
      for (let i = 0; i < 4 && fires.length === 0; i++) engine.tick(0.1);
      engine.dispose();
      expect(fires[0]!.target).toMatch(/^enemy:ga:/);
    });
  });
});
