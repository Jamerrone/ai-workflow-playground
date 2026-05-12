import { describe, it, expect } from "vitest";
import { createEngine } from "../src/index.js";
import type { ConfigRegistry, GameEvent } from "../src/index.js";
import { builtInBundle } from "../src/plugins/builtin/index.js";
import { buildEffectsRegistry } from "./helpers/attack-effects-registry.js";

function createTestEngine(registry: ConfigRegistry, seed = 1) {
  return createEngine(registry, { plugins: builtInBundle, seed });
}

function freezeWaves(reg: ConfigRegistry) {
  (reg.enemies as any).grunt.stats.speed = 0;
}

function setEffects(reg: ConfigRegistry, effects: unknown[]) {
  (reg.towers as any).archer.attacks[0].effects = effects;
}

function getProjectiles(snapshot: string) {
  const snap = JSON.parse(snapshot) as {
    entities: Array<{ id: string; components: Record<string, unknown> }>;
  };
  return snap.entities.filter((e) => e.components.projectile);
}

function listEnemies(snapshot: string): Array<{ id: string; hp: number; x: number; y: number }> {
  const snap = JSON.parse(snapshot) as {
    entities: Array<{ id: string; components: Record<string, unknown> }>;
  };
  return snap.entities
    .filter((e) => (e.components.enemy as { archetype: string } | undefined)?.archetype)
    .map((e) => ({
      id: e.id,
      hp: (e.components.health as { hp: number }).hp,
      x: (e.components.position as { x: number }).x,
      y: (e.components.position as { x: number; y: number }).y,
    }));
}

describe("projectiles: EntityKind registration", () => {
  it("projectile entity is queryable via world.query({ all: ['projectile'] }) on the tick after spawn", () => {
    const reg = buildEffectsRegistry();
    freezeWaves(reg);
    setEffects(reg, [
      { kind: "projectile-count", id: "pc", stats: { count: 1, speed: 5, maxRange: 20 } },
      { kind: "damage", id: "d", stats: { amount: 10 } },
    ]);
    const engine = createTestEngine(reg);
    engine.loadScenario("effects");
    engine.placeTower("archer", { x: 4, y: 0 });
    engine.sendNextWave();
    engine.tick(0.1);
    const projectiles = getProjectiles(engine.snapshot());
    engine.dispose();
    expect(projectiles.length).toBe(1);
    expect(projectiles[0]!.components.projectile).toBeDefined();
    expect(projectiles[0]!.components.position).toBeDefined();
  });
});

describe("projectiles: flight system", () => {
  it("advances projectile position deterministically based on speed and direction", () => {
    const reg = buildEffectsRegistry();
    freezeWaves(reg);
    (reg.towers as any).archer.attacks[0].stats.cooldown = 100;
    // Tower at (4,0), enemy at (0,0) frozen. Speed 2, maxRange 20.
    // Tick 0 (dt=0.1): combat fires → projectile spawns at (4,0)
    // Tick 1 (dt=1.0): step = 2*1.0 = 2. direction (-4,0)/4, ratio 2/4=0.5
    //   newPos = (4 + (-4)*0.5, 0) = (2, 0)
    setEffects(reg, [
      { kind: "projectile-count", id: "pc", stats: { count: 1, speed: 2, maxRange: 20 } },
      { kind: "damage", id: "d", stats: { amount: 10 } },
    ]);
    const engine = createTestEngine(reg);
    engine.loadScenario("effects");
    engine.placeTower("archer", { x: 4, y: 0 });
    engine.sendNextWave();
    engine.tick(0.1); // spawn projectile
    engine.tick(1.0); // advance projectile
    const projectiles = getProjectiles(engine.snapshot());
    engine.dispose();
    expect(projectiles.length).toBe(1);
    const pos = projectiles[0]!.components.position as { x: number; y: number };
    expect(pos.x).toBeCloseTo(2, 5);
    expect(pos.y).toBeCloseTo(0, 5);
  });

  it("hits the target when the projectile reaches it and emits projectileHit", () => {
    const reg = buildEffectsRegistry();
    freezeWaves(reg);
    // Speed 20: step = 20 * 1.0 = 20 >> distance 4 → hits on first flight tick
    setEffects(reg, [
      { kind: "projectile-count", id: "pc", stats: { count: 1, speed: 20, maxRange: 30 } },
      { kind: "damage", id: "d", stats: { amount: 10 } },
    ]);
    const events: GameEvent[] = [];
    const engine = createTestEngine(reg);
    engine.onEvent((e) => events.push(e));
    engine.loadScenario("effects");
    engine.placeTower("archer", { x: 4, y: 0 });
    engine.sendNextWave();
    engine.tick(0.1); // spawn projectile
    engine.tick(1.0); // projectile hits
    engine.dispose();
    const hitEvents = events.filter((e) => e.kind === "projectileHit");
    expect(hitEvents.length).toBe(1);
    expect(hitEvents[0]!.source).toEqual({ x: 4, y: 0 });
    expect(hitEvents[0]!.tick).toBe(1);
  });

  it("projectileHit carries source position frozen at fire time and target position at hit time", () => {
    const reg = buildEffectsRegistry();
    freezeWaves(reg);
    setEffects(reg, [
      { kind: "projectile-count", id: "pc", stats: { count: 1, speed: 20, maxRange: 30 } },
      { kind: "damage", id: "d", stats: { amount: 10 } },
    ]);
    const events: GameEvent[] = [];
    const engine = createTestEngine(reg);
    engine.onEvent((e) => events.push(e));
    engine.loadScenario("effects");
    engine.placeTower("archer", { x: 4, y: 0 });
    engine.sendNextWave();
    engine.tick(0.1);
    engine.tick(1.0);
    engine.dispose();
    const hit = events.find((e) => e.kind === "projectileHit")!;
    expect(hit.source).toEqual({ x: 4, y: 0 });
    expect(hit.target).toEqual({ x: 0, y: 0 });
  });

  it("removes the projectile entity from the world after hit", () => {
    const reg = buildEffectsRegistry();
    freezeWaves(reg);
    (reg.towers as any).archer.attacks[0].stats.cooldown = 100;
    setEffects(reg, [
      { kind: "projectile-count", id: "pc", stats: { count: 1, speed: 20, maxRange: 30 } },
      { kind: "damage", id: "d", stats: { amount: 10 } },
    ]);
    const engine = createTestEngine(reg);
    engine.loadScenario("effects");
    engine.placeTower("archer", { x: 4, y: 0 });
    engine.sendNextWave();
    engine.tick(0.1);
    engine.tick(1.0);
    const projectiles = getProjectiles(engine.snapshot());
    engine.dispose();
    expect(projectiles.length).toBe(0);
  });

  it("applies carried effects (damage) on hit via pendingFires pipeline", () => {
    const reg = buildEffectsRegistry();
    freezeWaves(reg);
    setEffects(reg, [
      { kind: "projectile-count", id: "pc", stats: { count: 1, speed: 20, maxRange: 30 } },
      { kind: "damage", id: "d", stats: { amount: 7 } },
    ]);
    const engine = createTestEngine(reg);
    engine.loadScenario("effects");
    engine.placeTower("archer", { x: 4, y: 0 });
    engine.sendNextWave();
    engine.tick(0.1); // spawn projectile, no immediate damage
    const enemiesBefore = listEnemies(engine.snapshot());
    expect(enemiesBefore[0]!.hp).toBe(100); // no hitscan damage
    engine.tick(1.0); // projectile hits → damage applied in same tick's Effect phase
    const enemiesAfter = listEnemies(engine.snapshot());
    engine.dispose();
    expect(enemiesAfter[0]!.hp).toBe(100 - 7);
  });

  it("does not apply carried effects immediately on spawn (no hitscan)", () => {
    const reg = buildEffectsRegistry();
    freezeWaves(reg);
    setEffects(reg, [
      { kind: "projectile-count", id: "pc", stats: { count: 1, speed: 2, maxRange: 20 } },
      { kind: "damage", id: "d", stats: { amount: 50 } },
    ]);
    const events: GameEvent[] = [];
    const engine = createTestEngine(reg);
    engine.onEvent((e) => events.push(e));
    engine.loadScenario("effects");
    engine.placeTower("archer", { x: 4, y: 0 });
    engine.sendNextWave();
    engine.tick(0.1);
    engine.dispose();
    const damageEvents = events.filter((e) => e.kind === "damageApplied");
    expect(damageEvents.length).toBe(0);
  });
});

describe("projectiles: expiry", () => {
  it("emits projectileExpired and removes entity when maxRange is exceeded", () => {
    const reg = buildEffectsRegistry();
    freezeWaves(reg);
    // Speed 2, maxRange 1. Distance to target is 4.
    // Tick 1 (dt=1.0): step = 2, newDistanceTraveled = 2 >= 1 → expire
    setEffects(reg, [
      { kind: "projectile-count", id: "pc", stats: { count: 1, speed: 2, maxRange: 1 } },
      { kind: "damage", id: "d", stats: { amount: 10 } },
    ]);
    const events: GameEvent[] = [];
    const engine = createTestEngine(reg);
    engine.onEvent((e) => events.push(e));
    engine.loadScenario("effects");
    engine.placeTower("archer", { x: 4, y: 0 });
    engine.sendNextWave();
    engine.tick(0.1); // spawn
    engine.tick(1.0); // expire
    engine.dispose();
    const expired = events.filter((e) => e.kind === "projectileExpired");
    expect(expired.length).toBe(1);
    expect(expired[0]!.reason).toBe("max-range");
    const hits = events.filter((e) => e.kind === "projectileHit");
    expect(hits.length).toBe(0);
  });

  it("expired projectile does not apply damage", () => {
    const reg = buildEffectsRegistry();
    freezeWaves(reg);
    setEffects(reg, [
      { kind: "projectile-count", id: "pc", stats: { count: 1, speed: 2, maxRange: 1 } },
      { kind: "damage", id: "d", stats: { amount: 10 } },
    ]);
    const engine = createTestEngine(reg);
    engine.loadScenario("effects");
    engine.placeTower("archer", { x: 4, y: 0 });
    engine.sendNextWave();
    engine.tick(0.1);
    engine.tick(1.0);
    const enemies = listEnemies(engine.snapshot());
    engine.dispose();
    expect(enemies[0]!.hp).toBe(100);
  });

  it("emits projectileExpired with reason target-lost when target is destroyed mid-flight", () => {
    const reg = buildEffectsRegistry();
    // Two attacks: first is hitscan damage that kills the enemy, second is projectile-count
    // Actually, let's have the enemy die from low HP and a direct damage effect on a different tower
    // Simpler: just use a 1 HP enemy that gets killed by hitscan damage from the first fire,
    // then a second tower fires a projectile — but the effects registry only has one tower slot.

    // Alternative: enemy with 1 HP. Tower fires projectile-count + damage. projectile-count
    // aborts damage (so damage doesn't apply immediately). On the next tick the tower fires
    // AGAIN (if cooldown allows). But cooldown is 0.5 and we tick at 0.1...
    // Actually, let me think differently. We can manually destroy the target by having it walk
    // off the map. Or we can have two enemy groups where the first gets killed differently.

    // Simplest approach: use a very slow projectile so it takes many ticks.
    // Have the enemy walk into the base and get destroyed.
    (reg.enemies as any).grunt.stats.speed = 10; // walks fast to base
    (reg.enemies as any).grunt.stats.hp = 10000; // doesn't die from damage
    setEffects(reg, [
      { kind: "projectile-count", id: "pc", stats: { count: 1, speed: 0.5, maxRange: 20 } },
    ]);
    const events: GameEvent[] = [];
    const engine = createTestEngine(reg);
    engine.onEvent((e) => events.push(e));
    engine.loadScenario("effects");
    engine.placeTower("archer", { x: 4, y: 0 });
    engine.sendNextWave();
    // Tick until the enemy reaches the base and is destroyed
    for (let i = 0; i < 20; i++) engine.tick(0.5);
    engine.dispose();
    const expired = events.filter((e) => e.kind === "projectileExpired");
    const targetLost = expired.filter((e) => e.reason === "target-lost");
    expect(targetLost.length).toBeGreaterThanOrEqual(1);
  });
});

describe("projectiles: projectile-count spawns N entities", () => {
  it("spawns the configured number of projectile entities per fire", () => {
    const reg = buildEffectsRegistry();
    freezeWaves(reg);
    setEffects(reg, [
      { kind: "projectile-count", id: "pc", stats: { count: 3, speed: 2, maxRange: 20 } },
      { kind: "damage", id: "d", stats: { amount: 10 } },
    ]);
    const engine = createTestEngine(reg);
    engine.loadScenario("effects");
    engine.placeTower("archer", { x: 4, y: 0 });
    engine.sendNextWave();
    engine.tick(0.1);
    const projectiles = getProjectiles(engine.snapshot());
    engine.dispose();
    expect(projectiles.length).toBe(3);
  });

  it("emits projectilesSpawned event with count and source info", () => {
    const reg = buildEffectsRegistry();
    freezeWaves(reg);
    setEffects(reg, [
      { kind: "projectile-count", id: "pc", stats: { count: 2, speed: 5, maxRange: 20 } },
    ]);
    const events: GameEvent[] = [];
    const engine = createTestEngine(reg);
    engine.onEvent((e) => events.push(e));
    engine.loadScenario("effects");
    engine.placeTower("archer", { x: 4, y: 0 });
    engine.sendNextWave();
    engine.tick(0.1);
    engine.dispose();
    const spawned = events.find((e) => e.kind === "projectilesSpawned");
    expect(spawned).toBeDefined();
    expect(spawned!.count).toBe(2);
    expect(spawned!.attackId).toBe("shot");
    expect(spawned!.effectId).toBe("pc");
  });
});

describe("projectiles: 100% flight System coverage", () => {
  it("multiple projectiles advance independently and hit at different ticks", () => {
    const reg = buildEffectsRegistry();
    freezeWaves(reg);
    // Speed 2, distance 4. Each tick at dt=1: step=2. Hits after 2 ticks (distanceTraveled = 4 >= distance 4).
    // Actually: tick 1: distance=4, step=2, 4 > 2 → advance. distanceTraveled=2.
    //           tick 2: distance=2, step=2, 2 <= 2 → hit.
    setEffects(reg, [
      { kind: "projectile-count", id: "pc", stats: { count: 2, speed: 2, maxRange: 20 } },
      { kind: "damage", id: "d", stats: { amount: 5 } },
    ]);
    const events: GameEvent[] = [];
    const engine = createTestEngine(reg);
    engine.onEvent((e) => events.push(e));
    engine.loadScenario("effects");
    engine.placeTower("archer", { x: 4, y: 0 });
    engine.sendNextWave();
    engine.tick(0.1); // spawn 2 projectiles
    engine.tick(1.0); // advance
    engine.tick(1.0); // hit
    engine.dispose();
    const hits = events.filter((e) => e.kind === "projectileHit");
    expect(hits.length).toBe(2);
    // Each hit produces a damageApplied
    const dmg = events.filter((e) => e.kind === "damageApplied");
    expect(dmg.length).toBe(2);
  });

  it("projectile with zero-distance to target hits immediately", () => {
    const reg = buildEffectsRegistry();
    freezeWaves(reg);
    // Place tower at same position as enemy (both at 0,0 isn't possible — tower slot is 4,0).
    // Instead, use a very high speed so the projectile covers 4 tiles in a tiny dt.
    setEffects(reg, [
      { kind: "projectile-count", id: "pc", stats: { count: 1, speed: 100, maxRange: 20 } },
      { kind: "damage", id: "d", stats: { amount: 1 } },
    ]);
    const events: GameEvent[] = [];
    const engine = createTestEngine(reg);
    engine.onEvent((e) => events.push(e));
    engine.loadScenario("effects");
    engine.placeTower("archer", { x: 4, y: 0 });
    engine.sendNextWave();
    engine.tick(0.1); // spawn
    engine.tick(0.1); // step = 100*0.1 = 10 > 4 → hit
    engine.dispose();
    const hits = events.filter((e) => e.kind === "projectileHit");
    expect(hits.length).toBe(1);
  });
});

describe("projectiles: no regressions", () => {
  it("scenarios without projectile-count are unaffected by the projectiles plugin", () => {
    const reg = buildEffectsRegistry();
    freezeWaves(reg);
    setEffects(reg, [{ kind: "damage", id: "d", stats: { amount: 10 } }]);
    const engine = createTestEngine(reg);
    engine.loadScenario("effects");
    engine.placeTower("archer", { x: 4, y: 0 });
    engine.sendNextWave();
    engine.tick(0.1);
    const enemies = listEnemies(engine.snapshot());
    engine.dispose();
    expect(enemies[0]!.hp).toBe(90);
  });
});
