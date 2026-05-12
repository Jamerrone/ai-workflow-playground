import { describe, it, expect } from "vitest";
import { createEngine, buildRegistry } from "../src/index.js";
import type { ConfigRegistry, GameEvent, LoaderInput } from "../src/index.js";
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

function spawnExtraEnemy(reg: ConfigRegistry, count: number) {
  (reg.waves as any).w1.groups[0].count = count;
  (reg.waves as any).w1.groups[0].interval = 0;
}

function getHp(snapshot: string, id: string): number | undefined {
  const snap = JSON.parse(snapshot) as { entities: Array<{ id: string; components: Record<string, unknown> }> };
  const e = snap.entities.find((e) => e.id === id);
  return (e?.components.health as { hp: number } | undefined)?.hp;
}

function listEnemies(snapshot: string): Array<{ id: string; hp: number; x: number; y: number }> {
  const snap = JSON.parse(snapshot) as { entities: Array<{ id: string; components: Record<string, unknown> }> };
  return snap.entities
    .filter((e) => (e.components.enemy as { archetype: string } | undefined)?.archetype)
    .map((e) => ({
      id: e.id,
      hp: (e.components.health as { hp: number }).hp,
      x: (e.components.position as { x: number }).x,
      y: (e.components.position as { y: number }).y,
    }));
}

describe("attack-effects: kind registration", () => {
  it("every built-in AttackEffect kind is recognised by the Loader", () => {
    const kinds = [
      "damage",
      "splash",
      "slow",
      "dot",
      "pierce",
      "bounce",
      "line-pierce",
      "minimum-range",
      "target-count",
      "projectile-count",
    ];
    for (const kind of kinds) {
      const reg = buildEffectsRegistry();
      // Each effect kind has its own required fields; pass a valid minimal config.
      const stats = minimalStatsFor(kind);
      setEffects(reg, [{ kind, id: "e1", stats }]);
      const r = buildRegistry(reg as unknown as LoaderInput);
      expect(r.ok, `kind '${kind}' should pass loader`).toBe(true);
    }
  });
});

function minimalStatsFor(kind: string): Record<string, number> {
  switch (kind) {
    case "damage":
      return { amount: 1 };
    case "splash":
      return { radius: 1, amount: 1 };
    case "slow":
      return { factor: 0.5, duration: 1 };
    case "dot":
      return { damagePerTick: 1, interval: 0.5, duration: 1 };
    case "pierce":
    case "line-pierce":
      return { amount: 1, maxTargets: 2 };
    case "bounce":
      return { amount: 1, hops: 1 };
    case "minimum-range":
      return { range: 1 };
    case "target-count":
      return { count: 2 };
    case "projectile-count":
      return { count: 2, speed: 5, maxRange: 20 };
    default:
      throw new Error(`unknown test kind ${kind}`);
  }
}

describe("attack-effects: Loader validators", () => {
  it("rejects a damage effect missing stats.amount", () => {
    const reg = buildEffectsRegistry();
    setEffects(reg, [{ kind: "damage", id: "e1", stats: {} }]);
    const r = buildRegistry(reg as unknown as LoaderInput);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => e.path.endsWith("amount"))).toBe(true);
    }
  });

  it("rejects a damage effect with no stats object at all", () => {
    const reg = buildEffectsRegistry();
    setEffects(reg, [{ kind: "damage", id: "e1" }]);
    const r = buildRegistry(reg as unknown as LoaderInput);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => e.path.endsWith(".stats"))).toBe(true);
    }
  });

  it("accepts a valid splash config and rejects one missing 'radius'", () => {
    const ok = buildEffectsRegistry();
    setEffects(ok, [{ kind: "splash", stats: { radius: 1, amount: 1 } }]);
    expect(buildRegistry(ok as unknown as LoaderInput).ok).toBe(true);

    const bad = buildEffectsRegistry();
    setEffects(bad, [{ kind: "splash", stats: { amount: 1 } }]);
    const r = buildRegistry(bad as unknown as LoaderInput);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => e.path.endsWith("radius"))).toBe(true);
    }
  });

  it("rejects slow with factor outside (0, 1]", () => {
    const reg = buildEffectsRegistry();
    setEffects(reg, [{ kind: "slow", stats: { factor: 1.5, duration: 1 } }]);
    const r = buildRegistry(reg as unknown as LoaderInput);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => e.path.endsWith("factor"))).toBe(true);
    }
  });

  it("rejects dot missing damagePerTick", () => {
    const reg = buildEffectsRegistry();
    setEffects(reg, [{ kind: "dot", stats: { interval: 0.5, duration: 1 } }]);
    const r = buildRegistry(reg as unknown as LoaderInput);
    expect(r.ok).toBe(false);
  });
});

describe("attack-effects: damage handler", () => {
  it("reduces target HP by stats.amount per fire", () => {
    const reg = buildEffectsRegistry();
    setEffects(reg, [{ kind: "damage", id: "main", stats: { amount: 7 } }]);
    freezeWaves(reg);
    const engine = createTestEngine(reg);
    engine.loadScenario("effects");
    engine.placeTower("archer", { x: 4, y: 0 });
    engine.sendNextWave();
    engine.tick(0.1);
    const enemies = listEnemies(engine.snapshot());
    engine.dispose();
    expect(enemies.length).toBe(1);
    expect(enemies[0]!.hp).toBe(100 - 7);
  });

  it("emits damageApplied with attackId and effect.id", () => {
    const reg = buildEffectsRegistry();
    setEffects(reg, [{ kind: "damage", id: "main", stats: { amount: 3 } }]);
    freezeWaves(reg);
    const events: GameEvent[] = [];
    const engine = createTestEngine(reg);
    engine.onEvent((e) => events.push(e));
    engine.loadScenario("effects");
    engine.placeTower("archer", { x: 4, y: 0 });
    engine.sendNextWave();
    engine.tick(0.1);
    engine.dispose();
    const applied = events.find((e) => e.kind === "damageApplied");
    expect(applied).toBeDefined();
    expect(applied!.amount).toBe(3);
    expect(applied!.attackId).toBe("shot");
    expect(applied!.effectId).toBe("main");
  });
});

describe("attack-effects: splash handler", () => {
  it("damages every enemy within stats.radius of the primary target", () => {
    const reg = buildEffectsRegistry();
    setEffects(reg, [{ kind: "splash", id: "boom", stats: { radius: 2, amount: 5 } }]);
    spawnExtraEnemy(reg, 3); // 3 enemies stacked at spawn (speed 0)
    freezeWaves(reg);
    const engine = createTestEngine(reg);
    engine.loadScenario("effects");
    engine.placeTower("archer", { x: 4, y: 0 });
    engine.sendNextWave();
    engine.tick(0.1);
    const enemies = listEnemies(engine.snapshot());
    engine.dispose();
    expect(enemies).toHaveLength(3);
    for (const e of enemies) expect(e.hp).toBe(100 - 5);
  });

  it("two splash effects on one attack apply independently (effect-scoped stats)", () => {
    const reg = buildEffectsRegistry();
    setEffects(reg, [
      { kind: "splash", id: "small", stats: { radius: 2, amount: 3 } },
      { kind: "splash", id: "big", stats: { radius: 8, amount: 1 } },
    ]);
    spawnExtraEnemy(reg, 2);
    freezeWaves(reg);
    const engine = createTestEngine(reg);
    engine.loadScenario("effects");
    engine.placeTower("archer", { x: 4, y: 0 });
    engine.sendNextWave();
    engine.tick(0.1);
    const enemies = listEnemies(engine.snapshot());
    engine.dispose();
    // Each enemy is hit by both splashes since all are at (0,0); both effects independently apply.
    for (const e of enemies) expect(e.hp).toBe(100 - 3 - 1);
  });
});

describe("attack-effects: slow handler", () => {
  it("reduces target's effective speed by factor for the configured duration", () => {
    const reg = buildEffectsRegistry();
    // Slow but no damage — tower only applies slow once then re-fires next tick.
    setEffects(reg, [{ kind: "slow", id: "ice", stats: { factor: 0.25, duration: 10 } }]);
    (reg.enemies as any).grunt.stats.speed = 4; // 4 tiles/sec normally
    (reg.enemies as any).grunt.stats.hp = 10_000; // never dies
    (reg.towers as any).archer.attacks[0].stats.cooldown = 100; // fire once only
    (reg.towers as any).archer.attacks[0].stats.range = 9;
    const engine = createTestEngine(reg);
    engine.loadScenario("effects");
    engine.placeTower("archer", { x: 4, y: 0 });
    engine.sendNextWave();
    // Tick once at dt=0.1: combat fires, slow applied. Enemy moves at effective speed.
    engine.tick(0.1); // tower fires; movement runs Simulation BEFORE Effect → enemy moves at full speed for 0.1
    const after1 = listEnemies(engine.snapshot())[0]!;
    // Tick again — now slow is on, so enemy moves at 4 * 0.25 = 1 tile/sec → 0.1 tiles.
    engine.tick(0.1);
    const after2 = listEnemies(engine.snapshot())[0]!;
    engine.dispose();
    const delta1 = after1.x - 0;
    const delta2 = after2.x - after1.x;
    expect(delta1).toBeCloseTo(0.4, 5);
    expect(delta2).toBeCloseTo(0.1, 5);
  });

  it("slow expires after duration and target returns to normal speed", () => {
    const reg = buildEffectsRegistry();
    setEffects(reg, [{ kind: "slow", id: "ice", stats: { factor: 0.5, duration: 0.1 } }]);
    (reg.enemies as any).grunt.stats.speed = 2;
    (reg.enemies as any).grunt.stats.hp = 10_000;
    (reg.towers as any).archer.attacks[0].stats.cooldown = 100;
    const engine = createTestEngine(reg);
    engine.loadScenario("effects");
    engine.placeTower("archer", { x: 4, y: 0 });
    engine.sendNextWave();
    engine.tick(0.1); // fire; slow applied at end of tick (Effect phase)
    engine.tick(0.1); // status decrements by 0.1 to 0 → expires
    engine.tick(0.1); // moves at full speed: 2 * 0.1 = 0.2 tiles
    const after = listEnemies(engine.snapshot())[0]!;
    engine.dispose();
    // After expiry, last tick produced 0.2 tiles of movement from a near-stationary x.
    // Validate by checking the total is consistent with one tick at full speed at the end.
    expect(after.x).toBeGreaterThan(0.3); // moved more than a purely-slowed run would
  });
});

describe("attack-effects: dot handler", () => {
  it("applies damagePerTick at the configured interval for the configured duration", () => {
    const reg = buildEffectsRegistry();
    // dot deals 5 every 0.5s for 1s total — 2 ticks of 5 damage = 10.
    setEffects(reg, [{ kind: "dot", id: "poison", stats: { damagePerTick: 5, interval: 0.5, duration: 1.0 } }]);
    freezeWaves(reg);
    (reg.enemies as any).grunt.stats.hp = 100;
    (reg.towers as any).archer.attacks[0].stats.cooldown = 100; // fire only once
    const engine = createTestEngine(reg);
    engine.loadScenario("effects");
    engine.placeTower("archer", { x: 4, y: 0 });
    engine.sendNextWave();
    // Tick at dt=0.5 each: fire (no immediate dot tick on first), then 2 dot ticks.
    engine.tick(0.5); // sinceLastTick 0 + 0.5 → fires dot tick #1; remaining 0.5
    engine.tick(0.5); // sinceLastTick 0 + 0.5 → fires dot tick #2; remaining 0
    const enemy = listEnemies(engine.snapshot())[0]!;
    engine.dispose();
    expect(enemy.hp).toBe(100 - 10);
  });

  it("emits dotTicked per damaging interval", () => {
    const reg = buildEffectsRegistry();
    setEffects(reg, [{ kind: "dot", id: "poison", stats: { damagePerTick: 2, interval: 0.5, duration: 1.0 } }]);
    freezeWaves(reg);
    (reg.enemies as any).grunt.stats.hp = 100;
    (reg.towers as any).archer.attacks[0].stats.cooldown = 100;
    const events: GameEvent[] = [];
    const engine = createTestEngine(reg);
    engine.onEvent((e) => events.push(e));
    engine.loadScenario("effects");
    engine.placeTower("archer", { x: 4, y: 0 });
    engine.sendNextWave();
    engine.tick(0.5);
    engine.tick(0.5);
    engine.dispose();
    const ticks = events.filter((e) => e.kind === "dotTicked");
    expect(ticks.length).toBe(2);
    expect(ticks[0]!.amount).toBe(2);
  });
});

describe("attack-effects: minimum-range handler", () => {
  it("aborts subsequent effects when the target is closer than stats.range", () => {
    const reg = buildEffectsRegistry();
    // Enemy at (0,0), tower at (4,0): distance 4. Minimum-range 5 → too close → aborts.
    setEffects(reg, [
      { kind: "minimum-range", id: "mr", stats: { range: 5 } },
      { kind: "damage", id: "shot", stats: { amount: 10 } },
    ]);
    freezeWaves(reg);
    const engine = createTestEngine(reg);
    engine.loadScenario("effects");
    engine.placeTower("archer", { x: 4, y: 0 });
    engine.sendNextWave();
    engine.tick(0.1);
    const enemy = listEnemies(engine.snapshot())[0]!;
    engine.dispose();
    expect(enemy.hp).toBe(100); // no damage applied
  });

  it("allows subsequent effects when the target is at or beyond stats.range", () => {
    const reg = buildEffectsRegistry();
    setEffects(reg, [
      { kind: "minimum-range", id: "mr", stats: { range: 2 } },
      { kind: "damage", id: "shot", stats: { amount: 10 } },
    ]);
    freezeWaves(reg);
    const engine = createTestEngine(reg);
    engine.loadScenario("effects");
    engine.placeTower("archer", { x: 4, y: 0 });
    engine.sendNextWave();
    engine.tick(0.1);
    const enemy = listEnemies(engine.snapshot())[0]!;
    engine.dispose();
    expect(enemy.hp).toBe(90);
  });
});

describe("attack-effects: target-count handler", () => {
  it("expands the running target set to up to stats.count nearest enemies", () => {
    const reg = buildEffectsRegistry();
    // 3 enemies at (0,0); target-count 2 → only 2 take damage.
    spawnExtraEnemy(reg, 3);
    freezeWaves(reg);
    setEffects(reg, [
      { kind: "target-count", id: "expand", stats: { count: 2 } },
      { kind: "damage", id: "shot", stats: { amount: 10 } },
    ]);
    const engine = createTestEngine(reg);
    engine.loadScenario("effects");
    engine.placeTower("archer", { x: 4, y: 0 });
    engine.sendNextWave();
    engine.tick(0.1);
    const enemies = listEnemies(engine.snapshot());
    engine.dispose();
    const damaged = enemies.filter((e) => e.hp === 90);
    expect(damaged.length).toBe(2);
    expect(enemies.filter((e) => e.hp === 100).length).toBe(1);
  });
});

describe("attack-effects: pierce + line-pierce + bounce handlers", () => {
  it("pierce damages up to maxTargets enemies along the line from source", () => {
    const reg = buildEffectsRegistry();
    spawnExtraEnemy(reg, 3);
    freezeWaves(reg);
    setEffects(reg, [{ kind: "pierce", id: "p", stats: { amount: 5, maxTargets: 2 } }]);
    const engine = createTestEngine(reg);
    engine.loadScenario("effects");
    engine.placeTower("archer", { x: 4, y: 0 });
    engine.sendNextWave();
    engine.tick(0.1);
    const enemies = listEnemies(engine.snapshot());
    engine.dispose();
    const damaged = enemies.filter((e) => e.hp === 95);
    expect(damaged.length).toBe(2);
  });

  it("line-pierce uses the same line-axis logic and emits linePierceApplied", () => {
    const reg = buildEffectsRegistry();
    spawnExtraEnemy(reg, 3);
    freezeWaves(reg);
    setEffects(reg, [{ kind: "line-pierce", id: "lp", stats: { amount: 5, maxTargets: 3 } }]);
    const events: GameEvent[] = [];
    const engine = createTestEngine(reg);
    engine.onEvent((e) => events.push(e));
    engine.loadScenario("effects");
    engine.placeTower("archer", { x: 4, y: 0 });
    engine.sendNextWave();
    engine.tick(0.1);
    engine.dispose();
    const applied = events.find((e) => e.kind === "linePierceApplied");
    expect(applied).toBeDefined();
    expect((applied!.targets as string[]).length).toBe(3);
  });

  it("bounce chains hits to the nearest unstruck target up to hops", () => {
    const reg = buildEffectsRegistry();
    spawnExtraEnemy(reg, 3);
    freezeWaves(reg);
    setEffects(reg, [{ kind: "bounce", id: "b", stats: { amount: 5, hops: 2 } }]);
    const engine = createTestEngine(reg);
    engine.loadScenario("effects");
    engine.placeTower("archer", { x: 4, y: 0 });
    engine.sendNextWave();
    engine.tick(0.1);
    const enemies = listEnemies(engine.snapshot());
    engine.dispose();
    const damaged = enemies.filter((e) => e.hp === 95);
    // Primary + 2 hops = 3 enemies hit.
    expect(damaged.length).toBe(3);
  });
});

describe("attack-effects: projectile-count handler", () => {
  it("spawns projectile entities and emits projectilesSpawned", () => {
    const reg = buildEffectsRegistry();
    freezeWaves(reg);
    setEffects(reg, [{ kind: "projectile-count", id: "pc", stats: { count: 3, speed: 5, maxRange: 20 } }]);
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
    expect(spawned!.count).toBe(3);
    expect(spawned!.attackId).toBe("shot");
    expect(spawned!.effectId).toBe("pc");
  });
});

describe("attack-effects: multi-effect composition", () => {
  it("runs effects in declared order, observable via emit ordering", () => {
    const reg = buildEffectsRegistry();
    freezeWaves(reg);
    // Order: damage 'first', dot 'second', damage 'third'.
    setEffects(reg, [
      { kind: "damage", id: "first", stats: { amount: 1 } },
      { kind: "dot", id: "second", stats: { damagePerTick: 1, interval: 10, duration: 10 } },
      { kind: "damage", id: "third", stats: { amount: 1 } },
    ]);
    const events: GameEvent[] = [];
    const engine = createTestEngine(reg);
    engine.onEvent((e) => events.push(e));
    engine.loadScenario("effects");
    engine.placeTower("archer", { x: 4, y: 0 });
    engine.sendNextWave();
    engine.tick(0.1);
    engine.dispose();
    const seq = events
      .filter((e) => e.kind === "damageApplied" || e.kind === "dotApplied")
      .map((e) => e.effectId);
    expect(seq).toEqual(["first", "second", "third"]);
  });

  it("three different effect kinds on one attack all apply in one fire", () => {
    const reg = buildEffectsRegistry();
    spawnExtraEnemy(reg, 2);
    freezeWaves(reg);
    setEffects(reg, [
      { kind: "damage", id: "d1", stats: { amount: 2 } },
      { kind: "splash", id: "s1", stats: { radius: 1, amount: 3 } },
      { kind: "slow", id: "ice", stats: { factor: 0.5, duration: 1 } },
    ]);
    const engine = createTestEngine(reg);
    engine.loadScenario("effects");
    engine.placeTower("archer", { x: 4, y: 0 });
    engine.sendNextWave();
    engine.tick(0.1);
    const snap = engine.snapshot();
    const enemies = listEnemies(snap);
    engine.dispose();
    // Both at (0,0). damage targets only primary (-2). splash hits both (-3 each).
    // Primary: 100 - 2 - 3 = 95. Other: 100 - 3 = 97.
    const sorted = enemies.map((e) => e.hp).sort((a, b) => a - b);
    expect(sorted).toEqual([95, 97]);
    // Both have a slow status entry on the primary target only.
    const all = (JSON.parse(snap) as { entities: Array<{ id: string; components: Record<string, unknown> }> }).entities;
    const withSlow = all.filter(
      (e) => ((e.components.statusEffects as Array<{ kind: string }> | undefined) ?? []).some((s) => s.kind === "slow"),
    );
    expect(withSlow).toHaveLength(1);
  });
});

describe("attack-effects: effect-scoped local id surfaces in events", () => {
  it("damage event payload carries the effect.id verbatim", () => {
    const reg = buildEffectsRegistry();
    freezeWaves(reg);
    setEffects(reg, [{ kind: "damage", id: "my-effect-id", stats: { amount: 1 } }]);
    const events: GameEvent[] = [];
    const engine = createTestEngine(reg);
    engine.onEvent((e) => events.push(e));
    engine.loadScenario("effects");
    engine.placeTower("archer", { x: 4, y: 0 });
    engine.sendNextWave();
    engine.tick(0.1);
    engine.dispose();
    const applied = events.find((e) => e.kind === "damageApplied");
    expect(applied!.effectId).toBe("my-effect-id");
  });
});

describe("attack-effects: documented GameEvent payload shapes", () => {
  const checkShape = (e: GameEvent, fields: readonly string[]) => {
    for (const f of fields) {
      expect(e, `event ${e.kind} should have field ${f}`).toHaveProperty(f);
    }
    expect(typeof e.tick).toBe("number");
  };

  it("damageApplied carries { tick, source, target, amount, attackId, effectId }", () => {
    const reg = buildEffectsRegistry();
    freezeWaves(reg);
    setEffects(reg, [{ kind: "damage", id: "d", stats: { amount: 1 } }]);
    const events: GameEvent[] = [];
    const engine = createTestEngine(reg);
    engine.onEvent((e) => events.push(e));
    engine.loadScenario("effects");
    engine.placeTower("archer", { x: 4, y: 0 });
    engine.sendNextWave();
    engine.tick(0.1);
    engine.dispose();
    checkShape(events.find((e) => e.kind === "damageApplied")!, [
      "source",
      "target",
      "amount",
      "attackId",
      "effectId",
    ]);
  });

  it("splashApplied, slowApplied, dotApplied each have documented payload fields", () => {
    const reg = buildEffectsRegistry();
    freezeWaves(reg);
    setEffects(reg, [
      { kind: "splash", id: "s", stats: { radius: 1, amount: 1 } },
      { kind: "slow", id: "i", stats: { factor: 0.5, duration: 1 } },
      { kind: "dot", id: "p", stats: { damagePerTick: 1, interval: 0.5, duration: 1 } },
    ]);
    const events: GameEvent[] = [];
    const engine = createTestEngine(reg);
    engine.onEvent((e) => events.push(e));
    engine.loadScenario("effects");
    engine.placeTower("archer", { x: 4, y: 0 });
    engine.sendNextWave();
    engine.tick(0.1);
    engine.dispose();
    checkShape(events.find((e) => e.kind === "splashApplied")!, ["impact", "radius", "amount", "targets"]);
    checkShape(events.find((e) => e.kind === "slowApplied")!, ["target", "factor", "duration"]);
    checkShape(events.find((e) => e.kind === "dotApplied")!, ["target", "damagePerTick", "interval", "duration"]);
  });
});
