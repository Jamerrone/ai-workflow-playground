/**
 * GameEvent payload assertion harness.
 *
 * Every documented GameEvent kind emitted by the built-in plugins has one
 * assertion entry here. The meta-check at the bottom of this file scans
 * src/ for emitted kinds and fails if any are missing from CANONICAL_EVENT_KINDS.
 *
 * To add a new event:
 *   1. Add its kind to CANONICAL_EVENT_KINDS.
 *   2. Write an assertion in the appropriate describe block below.
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createEngine } from "../src/index.js";
import type { ConfigRegistry, GameEvent, Plugin } from "../src/index.js";
import { builtInBundle } from "../src/plugins/builtin/index.js";
import { buildTracerRegistry } from "./helpers/tracer-registry.js";
import { buildEffectsRegistry } from "./helpers/attack-effects-registry.js";
import { buildUpgradesRegistry } from "./helpers/upgrades-registry.js";

// ---------------------------------------------------------------------------
// Canonical set — every event kind emitted by src/ must appear here.
// ---------------------------------------------------------------------------
const CANONICAL_EVENT_KINDS = new Set([
  "attackEffectUnknown",
  "baseDamaged",
  "bounceApplied",
  "damageApplied",
  "dotApplied",
  "dotTicked",
  "enemyAttacked",
  "enemyKilled",
  "enemyReachedBase",
  "entityHealed",
  "goldChanged",
  "guardAttacked",
  "guardDespawned",
  "guardDied",
  "guardSpawned",
  "linePierceApplied",
  "minimumRangeRejected",
  "pierceApplied",
  "projectileCountIntent",
  "projectileExpired",
  "projectileHit",
  "projectilesSpawned",
  "REGISTRY_REPLACEMENT",
  "rallyPointMoved",
  "scenarioLost",
  "scenarioWon",
  "slowApplied",
  "splashApplied",
  "targetCountApplied",
  "targetingOverridden",
  "towerFired",
  "towerPlaced",
  "towerSold",
  "upgradePurchased",
  "waveCleared",
  "waveStarted",
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function collectEvents(setup: (engine: ReturnType<typeof createEngine>) => void, maxTicks = 200): GameEvent[] {
  return setup as unknown as GameEvent[]; // overloaded below
}

function runScenario(
  registry: ConfigRegistry,
  setup: (eng: ReturnType<typeof createEngine>) => void,
  maxTicks = 200,
): GameEvent[] {
  const engine = createEngine(registry, { plugins: builtInBundle, seed: 1 });
  const events: GameEvent[] = [];
  engine.onEvent((e) => events.push(e));
  setup(engine);
  for (let i = 0; i < maxTicks; i++) {
    engine.tick(0.1);
    // Stop once scenario ends
    if (events.some((e) => e.kind === "scenarioWon" || e.kind === "scenarioLost")) break;
  }
  engine.dispose();
  return events;
}

function findFirst(events: GameEvent[], kind: string): GameEvent | undefined {
  return events.find((e) => e.kind === kind);
}

function setEffects(reg: ConfigRegistry, effects: unknown[]): void {
  (reg.towers as Record<string, Record<string, unknown>>).archer!.attacks =
    [{ id: "shot", stats: { range: 9, cooldown: 0.1 }, targetFilter: { require: [], exclude: [] }, effects }];
}

// ---------------------------------------------------------------------------
// Barracks registry helper (guards, ally-combat events)
// ---------------------------------------------------------------------------
function buildBarracksRegistry(): ConfigRegistry {
  return {
    components: {},
    entityKinds: {},
    maps: {
      m: {
        width: 10,
        height: 3,
        paths: [
          {
            id: "p1",
            kind: "ground",
            waypoints: [
              { x: 2, y: 1 },
              { x: 9, y: 1 },
            ],
          },
        ],
        bases: [{ id: "b1", position: { x: 9, y: 1 } }],
        towerSlots: [{ x: 1, y: 1 }],
        placementMode: { kind: "fixed" },
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
            respawnCooldown: 99,
            rallyPointRange: 6,
          },
        },
      },
    },
    enemies: {
      grunt: {
        tags: ["ground"],
        stats: { hp: 5, speed: 0, baseDamage: 1 },
        killReward: 0,
        attacks: [
          {
            id: "punch",
            stats: { range: 2, cooldown: 0.1 },
            effects: [{ kind: "damage", stats: { amount: 1 } }],
          },
        ],
      },
    },
    summons: {
      "guard-footman": {
        hp: 20,
        speed: 0,
        idleRegen: 0,
        attacks: [
          {
            id: "stab",
            stats: { range: 3, cooldown: 0.1 },
            effects: [{ kind: "damage", stats: { amount: 2 } }],
          },
        ],
      },
    },
    waves: {
      w1: {
        groups: [{ id: "g1", enemy: "grunt", count: 1, interval: 0, delay: 0 }],
      },
    },
    scenarios: {
      s: {
        map: "m",
        waves: [{ id: "w1", pathBindings: { g1: "p1" } }],
        waveTrigger: { kind: "manual" },
        gameRuleOverrides: { globalBaseHealth: 100, startingGold: 0 },
      },
    },
    upgrades: {},
    difficulties: {},
    gameRules: {},
  };
}

// ---------------------------------------------------------------------------
// Tower actions
// ---------------------------------------------------------------------------
describe("game-event-payloads: tower actions", () => {
  it("towerPlaced — payload shape", () => {
    const reg = buildTracerRegistry();
    const events = runScenario(reg, (eng) => {
      eng.loadScenario("tracer");
      eng.placeTower("archer", { x: 2, y: 0 });
    }, 0);
    const e = findFirst(events, "towerPlaced");
    expect(e).toMatchObject({
      kind: "towerPlaced",
      tick: 0,
      tower: expect.any(String),
      archetype: "archer",
      position: { x: 2, y: 0 },
    });
  });

  it("goldChanged — payload shape", () => {
    const reg = buildTracerRegistry();
    const events = runScenario(reg, (eng) => {
      eng.loadScenario("tracer");
      eng.placeTower("archer", { x: 2, y: 0 });
    }, 0);
    const e = findFirst(events, "goldChanged");
    expect(e).toMatchObject({
      kind: "goldChanged",
      tick: 0,
      delta: expect.any(Number),
      amount: expect.any(Number),
    });
  });

  it("targetingOverridden — payload shape", () => {
    const reg = buildTracerRegistry();
    const events = runScenario(reg, (eng) => {
      eng.loadScenario("tracer");
      const placed = eng.placeTower("archer", { x: 2, y: 0 });
      expect(placed.ok).toBe(true);
      if (placed.ok) eng.overrideTargeting((placed.effect as { entityId: string }).entityId, "closest-to-base");
    }, 0);
    const e = findFirst(events, "targetingOverridden");
    expect(e).toMatchObject({
      kind: "targetingOverridden",
      tick: 0,
      tower: expect.any(String),
      strategy: { kind: "closest-to-base" },
    });
  });

  it("towerSold — payload shape", () => {
    const reg = buildTracerRegistry();
    const events = runScenario(reg, (eng) => {
      eng.loadScenario("tracer");
      const placed = eng.placeTower("archer", { x: 2, y: 0 });
      expect(placed.ok).toBe(true);
      if (placed.ok) eng.sellTower((placed.effect as { entityId: string }).entityId);
    }, 0);
    const e = findFirst(events, "towerSold");
    expect(e).toMatchObject({
      kind: "towerSold",
      tick: 0,
      tower: expect.any(String),
      archetype: "archer",
      refund: expect.any(Number),
    });
  });
});

// ---------------------------------------------------------------------------
// Wave events
// ---------------------------------------------------------------------------
describe("game-event-payloads: wave events", () => {
  it("waveStarted — payload shape", () => {
    const reg = buildTracerRegistry();
    const events = runScenario(reg, (eng) => {
      eng.loadScenario("tracer");
      eng.placeTower("archer", { x: 2, y: 0 });
      eng.sendNextWave();
    }, 0);
    const e = findFirst(events, "waveStarted");
    expect(e).toMatchObject({
      kind: "waveStarted",
      tick: 0,
      waveIndex: 0,
      trigger: "manual",
    });
  });

  it("waveCleared — payload shape", () => {
    const reg = buildTracerRegistry();
    const events = runScenario(reg, (eng) => {
      eng.loadScenario("tracer");
      eng.placeTower("archer", { x: 2, y: 0 });
      eng.sendNextWave();
    });
    const e = findFirst(events, "waveCleared");
    expect(e).toMatchObject({
      kind: "waveCleared",
      waveIndex: 0,
      surviving: expect.any(Number),
      reward: expect.any(Number),
    });
  });

  it("scenarioWon — payload shape", () => {
    const reg = buildTracerRegistry();
    const events = runScenario(reg, (eng) => {
      eng.loadScenario("tracer");
      eng.placeTower("archer", { x: 2, y: 0 });
      eng.sendNextWave();
    });
    const e = findFirst(events, "scenarioWon");
    expect(e).toMatchObject({ kind: "scenarioWon", tick: expect.any(Number) });
  });

  it("scenarioLost — payload shape", () => {
    // No tower, one enemy that reaches the base and deals lethal damage.
    const reg = buildTracerRegistry();
    (reg.enemies as Record<string, Record<string, unknown>>).grunt!.stats =
      { hp: 100, speed: 10, baseDamage: 999 };
    const events = runScenario(reg, (eng) => {
      eng.loadScenario("tracer");
      eng.sendNextWave();
    });
    const e = findFirst(events, "scenarioLost");
    expect(e).toMatchObject({ kind: "scenarioLost", tick: expect.any(Number) });
  });
});

// ---------------------------------------------------------------------------
// Upgrade events
// ---------------------------------------------------------------------------
describe("game-event-payloads: upgrade events", () => {
  it("upgradePurchased — payload shape", () => {
    const reg = buildUpgradesRegistry();
    const events = runScenario(reg, (eng) => {
      eng.loadScenario("upgradesScenario");
      const placed = eng.placeTower("archer", { x: 4, y: 0 });
      expect(placed.ok).toBe(true);
      if (placed.ok) {
        const towerId = (placed.effect as { entityId: string }).entityId;
        eng.purchaseUpgrade(towerId, "damage-boost");
      }
    }, 0);
    const e = findFirst(events, "upgradePurchased");
    expect(e).toMatchObject({
      kind: "upgradePurchased",
      tick: 0,
      tower: expect.any(String),
      upgrade: "damage-boost",
      delta: expect.any(Number),
      amount: expect.any(Number),
    });
  });
});

// ---------------------------------------------------------------------------
// Combat events
// ---------------------------------------------------------------------------
describe("game-event-payloads: combat events", () => {
  it("towerFired — payload shape", () => {
    const reg = buildTracerRegistry();
    const events = runScenario(reg, (eng) => {
      eng.loadScenario("tracer");
      eng.placeTower("archer", { x: 2, y: 0 });
      eng.sendNextWave();
    });
    const e = findFirst(events, "towerFired");
    expect(e).toMatchObject({
      kind: "towerFired",
      tick: expect.any(Number),
      source: expect.any(String),
      target: expect.any(String),
      sourcePosition: { x: expect.any(Number), y: expect.any(Number) },
      targetPosition: { x: expect.any(Number), y: expect.any(Number) },
      attackId: "shot",
    });
  });

  it("damageApplied — payload shape", () => {
    const reg = buildEffectsRegistry();
    (reg.enemies as Record<string, Record<string, unknown>>).grunt!.stats =
      { hp: 100, speed: 0, baseDamage: 1 };
    const events = runScenario(reg, (eng) => {
      eng.loadScenario("effects");
      eng.placeTower("archer", { x: 4, y: 0 });
      eng.sendNextWave();
    });
    const e = findFirst(events, "damageApplied");
    expect(e).toMatchObject({
      kind: "damageApplied",
      tick: expect.any(Number),
      source: expect.any(String),
      target: expect.any(String),
      amount: expect.any(Number),
      attackId: "shot",
    });
  });

  it("enemyKilled — payload shape", () => {
    const reg = buildTracerRegistry();
    const events = runScenario(reg, (eng) => {
      eng.loadScenario("tracer");
      eng.placeTower("archer", { x: 2, y: 0 });
      eng.sendNextWave();
    });
    const e = findFirst(events, "enemyKilled");
    expect(e).toMatchObject({
      kind: "enemyKilled",
      tick: expect.any(Number),
      enemy: expect.any(String),
      killReward: expect.any(Number),
    });
  });

  it("enemyReachedBase — payload shape", () => {
    const reg = buildTracerRegistry();
    (reg.enemies as Record<string, Record<string, unknown>>).grunt!.stats =
      { hp: 100, speed: 10, baseDamage: 1 };
    const events = runScenario(reg, (eng) => {
      eng.loadScenario("tracer");
      eng.sendNextWave();
    });
    const e = findFirst(events, "enemyReachedBase");
    expect(e).toMatchObject({
      kind: "enemyReachedBase",
      tick: expect.any(Number),
      enemy: expect.any(String),
      base: "b1",
      damage: 1,
    });
  });

  it("baseDamaged — payload shape", () => {
    const reg = buildTracerRegistry();
    (reg.enemies as Record<string, Record<string, unknown>>).grunt!.stats =
      { hp: 100, speed: 10, baseDamage: 3 };
    (reg.scenarios as Record<string, Record<string, unknown>>).tracer!.gameRuleOverrides =
      { globalBaseHealth: 100, startingGold: 100 };
    const events = runScenario(reg, (eng) => {
      eng.loadScenario("tracer");
      eng.sendNextWave();
    });
    const e = findFirst(events, "baseDamaged");
    expect(e).toMatchObject({
      kind: "baseDamaged",
      tick: expect.any(Number),
      base: "b1",
      damage: 3,
      remainingHp: expect.any(Number),
    });
  });
});

// ---------------------------------------------------------------------------
// Attack effects
// ---------------------------------------------------------------------------
describe("game-event-payloads: attack effects", () => {
  function makeEffectEngine(effects: unknown[]): GameEvent[] {
    const reg = buildEffectsRegistry();
    (reg.enemies as Record<string, Record<string, unknown>>).grunt!.stats =
      { hp: 1000, speed: 0, baseDamage: 1 };
    setEffects(reg, effects);
    return runScenario(reg, (eng) => {
      eng.loadScenario("effects");
      eng.placeTower("archer", { x: 4, y: 0 });
      eng.sendNextWave();
    }, 50);
  }

  it("splashApplied — payload shape", () => {
    const events = makeEffectEngine([
      { kind: "splash", id: "s1", stats: { radius: 2, amount: 5 } },
    ]);
    const e = findFirst(events, "splashApplied");
    expect(e).toMatchObject({
      kind: "splashApplied",
      tick: expect.any(Number),
      source: expect.any(String),
      impact: { x: expect.any(Number), y: expect.any(Number) },
      radius: 2,
      amount: 5,
      attackId: "shot",
      targets: expect.any(Array),
    });
  });

  it("slowApplied — payload shape", () => {
    const events = makeEffectEngine([
      { kind: "slow", id: "s1", stats: { factor: 0.5, duration: 2 } },
    ]);
    const e = findFirst(events, "slowApplied");
    expect(e).toMatchObject({
      kind: "slowApplied",
      tick: expect.any(Number),
      source: expect.any(String),
      target: expect.any(String),
      factor: 0.5,
      duration: 2,
      attackId: "shot",
    });
  });

  it("dotApplied — payload shape", () => {
    const events = makeEffectEngine([
      { kind: "dot", id: "d1", stats: { damagePerTick: 3, interval: 0.1, duration: 1 } },
    ]);
    const e = findFirst(events, "dotApplied");
    expect(e).toMatchObject({
      kind: "dotApplied",
      tick: expect.any(Number),
      source: expect.any(String),
      target: expect.any(String),
      damagePerTick: 3,
      interval: 0.1,
      duration: 1,
      attackId: "shot",
    });
  });

  it("dotTicked — payload shape", () => {
    const events = makeEffectEngine([
      { kind: "dot", id: "d1", stats: { damagePerTick: 3, interval: 0.1, duration: 2 } },
    ]);
    const e = findFirst(events, "dotTicked");
    expect(e).toMatchObject({
      kind: "dotTicked",
      tick: expect.any(Number),
      target: expect.any(String),
      amount: 3,
      effectId: "d1",
    });
  });

  it("bounceApplied — payload shape (requires 2 enemies)", () => {
    const reg = buildEffectsRegistry();
    (reg.enemies as Record<string, Record<string, unknown>>).grunt!.stats =
      { hp: 1000, speed: 0, baseDamage: 1 };
    // Spawn 2 enemies so bounce has a chain target.
    (reg.waves as Record<string, Record<string, unknown>>).w1!.groups =
      [{ id: "g1", enemy: "grunt", count: 2, interval: 0, delay: 0 }];
    setEffects(reg, [{ kind: "bounce", id: "b1", stats: { amount: 5, hops: 1 } }]);
    const events = runScenario(reg, (eng) => {
      eng.loadScenario("effects");
      eng.placeTower("archer", { x: 4, y: 0 });
      eng.sendNextWave();
    }, 50);
    const e = findFirst(events, "bounceApplied");
    expect(e).toMatchObject({
      kind: "bounceApplied",
      tick: expect.any(Number),
      source: expect.any(String),
      amount: 5,
      hops: 1,
      attackId: "shot",
      chain: expect.any(Array),
    });
  });

  it("pierceApplied — payload shape (requires 2 enemies)", () => {
    const reg = buildEffectsRegistry();
    (reg.enemies as Record<string, Record<string, unknown>>).grunt!.stats =
      { hp: 1000, speed: 0, baseDamage: 1 };
    (reg.waves as Record<string, Record<string, unknown>>).w1!.groups =
      [{ id: "g1", enemy: "grunt", count: 2, interval: 0, delay: 0 }];
    setEffects(reg, [{ kind: "pierce", id: "p1", stats: { amount: 5, maxTargets: 2 } }]);
    const events = runScenario(reg, (eng) => {
      eng.loadScenario("effects");
      eng.placeTower("archer", { x: 4, y: 0 });
      eng.sendNextWave();
    }, 50);
    const e = findFirst(events, "pierceApplied");
    expect(e).toMatchObject({
      kind: "pierceApplied",
      tick: expect.any(Number),
      source: expect.any(String),
      amount: 5,
      maxTargets: 2,
      attackId: "shot",
      targets: expect.any(Array),
    });
  });

  it("linePierceApplied — payload shape", () => {
    const reg = buildEffectsRegistry();
    (reg.enemies as Record<string, Record<string, unknown>>).grunt!.stats =
      { hp: 1000, speed: 0, baseDamage: 1 };
    (reg.waves as Record<string, Record<string, unknown>>).w1!.groups =
      [{ id: "g1", enemy: "grunt", count: 2, interval: 0, delay: 0 }];
    setEffects(reg, [{ kind: "line-pierce", id: "lp1", stats: { amount: 5, maxTargets: 2 } }]);
    const events = runScenario(reg, (eng) => {
      eng.loadScenario("effects");
      eng.placeTower("archer", { x: 4, y: 0 });
      eng.sendNextWave();
    }, 50);
    const e = findFirst(events, "linePierceApplied");
    expect(e).toMatchObject({
      kind: "linePierceApplied",
      tick: expect.any(Number),
      source: expect.any(String),
      amount: 5,
      maxTargets: 2,
      attackId: "shot",
      targets: expect.any(Array),
    });
  });

  it("minimumRangeRejected — payload shape (enemy inside minimum range)", () => {
    // Enemy starts at (0,0), tower at (4,0). Min range = 5 > dist(4,4-0) = 4.
    // Enemy spawns right inside min range so the check fires.
    const reg = buildEffectsRegistry();
    (reg.enemies as Record<string, Record<string, unknown>>).grunt!.stats =
      { hp: 1000, speed: 0, baseDamage: 1 };
    // Enemy starts at waypoint (0,0); tower at (4,0); distance = 4.
    setEffects(reg, [
      { kind: "minimum-range", id: "mr1", stats: { range: 5 } },
      { kind: "damage", id: "d1", stats: { amount: 1 } },
    ]);
    const events = runScenario(reg, (eng) => {
      eng.loadScenario("effects");
      eng.placeTower("archer", { x: 4, y: 0 });
      eng.sendNextWave();
    }, 20);
    const e = findFirst(events, "minimumRangeRejected");
    expect(e).toMatchObject({
      kind: "minimumRangeRejected",
      tick: expect.any(Number),
      source: expect.any(String),
      target: expect.any(String),
      distance: expect.any(Number),
      range: 5,
      attackId: "shot",
    });
  });

  it("targetCountApplied — payload shape", () => {
    const reg = buildEffectsRegistry();
    (reg.enemies as Record<string, Record<string, unknown>>).grunt!.stats =
      { hp: 1000, speed: 0, baseDamage: 1 };
    (reg.waves as Record<string, Record<string, unknown>>).w1!.groups =
      [{ id: "g1", enemy: "grunt", count: 3, interval: 0, delay: 0 }];
    setEffects(reg, [
      { kind: "target-count", id: "tc1", stats: { count: 2 } },
      { kind: "damage", id: "d1", stats: { amount: 1 } },
    ]);
    const events = runScenario(reg, (eng) => {
      eng.loadScenario("effects");
      eng.placeTower("archer", { x: 4, y: 0 });
      eng.sendNextWave();
    }, 50);
    const e = findFirst(events, "targetCountApplied");
    expect(e).toMatchObject({
      kind: "targetCountApplied",
      tick: expect.any(Number),
      source: expect.any(String),
      count: expect.any(Number),
      attackId: "shot",
      targets: expect.any(Array),
    });
  });

  it("attackEffectUnknown — payload shape (unregistered effect kind)", () => {
    // Bypass loader, configure an unregistered effect kind directly.
    const reg = buildEffectsRegistry();
    (reg.enemies as Record<string, Record<string, unknown>>).grunt!.stats =
      { hp: 1000, speed: 0, baseDamage: 1 };
    setEffects(reg, [{ kind: "no-such-effect-zzz", id: "x1", stats: {} }]);
    const events = runScenario(reg, (eng) => {
      eng.loadScenario("effects");
      eng.placeTower("archer", { x: 4, y: 0 });
      eng.sendNextWave();
    }, 20);
    const e = findFirst(events, "attackEffectUnknown");
    expect(e).toMatchObject({
      kind: "attackEffectUnknown",
      tick: expect.any(Number),
      source: expect.any(String),
      effectKind: "no-such-effect-zzz",
      attackId: "shot",
    });
  });
});

// ---------------------------------------------------------------------------
// Projectile events
// ---------------------------------------------------------------------------
describe("game-event-payloads: projectile events", () => {
  it("projectileCountIntent — payload shape", () => {
    // projectilesPlugin overrides the projectile-count AttackEffect registered by
    // attackEffectsPlugin, suppressing projectileCountIntent. Use bundle without it.
    const bundleWithoutProjectiles = builtInBundle.filter((p) => p.id !== "projectiles");
    const reg = buildEffectsRegistry();
    (reg.enemies as Record<string, Record<string, unknown>>).grunt!.stats =
      { hp: 1000, speed: 0, baseDamage: 1 };
    setEffects(reg, [
      { kind: "projectile-count", id: "pc1", stats: { count: 1, speed: 5, maxRange: 20 } },
      { kind: "damage", id: "d1", stats: { amount: 1 } },
    ]);
    const engine = createEngine(reg, { plugins: bundleWithoutProjectiles, seed: 1 });
    const events: GameEvent[] = [];
    engine.onEvent((e) => events.push(e));
    engine.loadScenario("effects");
    engine.placeTower("archer", { x: 4, y: 0 });
    engine.sendNextWave();
    for (let i = 0; i < 30; i++) {
      engine.tick(0.1);
      if (events.some((e) => e.kind === "scenarioWon" || e.kind === "scenarioLost")) break;
    }
    engine.dispose();
    const e = findFirst(events, "projectileCountIntent");
    expect(e).toMatchObject({
      kind: "projectileCountIntent",
      tick: expect.any(Number),
      source: expect.any(String),
      target: expect.any(String),
      count: 1,
      attackId: "shot",
    });
  });

  it("projectilesSpawned — payload shape", () => {
    const reg = buildEffectsRegistry();
    (reg.enemies as Record<string, Record<string, unknown>>).grunt!.stats =
      { hp: 1000, speed: 0, baseDamage: 1 };
    setEffects(reg, [
      { kind: "projectile-count", id: "pc1", stats: { count: 1, speed: 5, maxRange: 20 } },
      { kind: "damage", id: "d1", stats: { amount: 1 } },
    ]);
    const events = runScenario(reg, (eng) => {
      eng.loadScenario("effects");
      eng.placeTower("archer", { x: 4, y: 0 });
      eng.sendNextWave();
    }, 30);
    const e = findFirst(events, "projectilesSpawned");
    expect(e).toMatchObject({
      kind: "projectilesSpawned",
      tick: expect.any(Number),
      source: expect.any(String),
      target: expect.any(String),
      count: 1,
      attackId: "shot",
    });
  });

  it("projectileHit — payload shape", () => {
    const reg = buildEffectsRegistry();
    (reg.enemies as Record<string, Record<string, unknown>>).grunt!.stats =
      { hp: 1000, speed: 0, baseDamage: 1 };
    setEffects(reg, [
      { kind: "projectile-count", id: "pc1", stats: { count: 1, speed: 50, maxRange: 20 } },
      { kind: "damage", id: "d1", stats: { amount: 1 } },
    ]);
    const events = runScenario(reg, (eng) => {
      eng.loadScenario("effects");
      eng.placeTower("archer", { x: 4, y: 0 });
      eng.sendNextWave();
    }, 30);
    const e = findFirst(events, "projectileHit");
    expect(e).toMatchObject({
      kind: "projectileHit",
      tick: expect.any(Number),
      projectile: expect.any(String),
      source: { x: expect.any(Number), y: expect.any(Number) },
      target: { x: expect.any(Number), y: expect.any(Number) },
    });
  });

  it("projectileExpired (max-range) — payload shape", () => {
    const reg = buildEffectsRegistry();
    (reg.enemies as Record<string, Record<string, unknown>>).grunt!.stats =
      { hp: 1000, speed: 0, baseDamage: 1 };
    // Enemy at (0,0), tower at (4,0), distance = 4. Set maxRange = 2 so
    // projectile expires before reaching the enemy.
    setEffects(reg, [
      { kind: "projectile-count", id: "pc1", stats: { count: 1, speed: 1, maxRange: 2 } },
      { kind: "damage", id: "d1", stats: { amount: 1 } },
    ]);
    const events = runScenario(reg, (eng) => {
      eng.loadScenario("effects");
      eng.placeTower("archer", { x: 4, y: 0 });
      eng.sendNextWave();
    }, 30);
    const e = findFirst(events, "projectileExpired");
    expect(e).toMatchObject({
      kind: "projectileExpired",
      tick: expect.any(Number),
      projectile: expect.any(String),
      reason: expect.stringMatching(/max-range|target-lost/),
    });
  });

  it("projectileExpired (target-lost) — payload shape", () => {
    // Two effects: damage (kills the enemy immediately) then projectile-count
    // (spawns a projectile whose target is already gone next tick).
    const reg = buildEffectsRegistry();
    (reg.enemies as Record<string, Record<string, unknown>>).grunt!.stats =
      { hp: 1, speed: 0, baseDamage: 1 };
    setEffects(reg, [
      { kind: "damage", id: "d1", stats: { amount: 999 } },
      { kind: "projectile-count", id: "pc1", stats: { count: 1, speed: 1, maxRange: 20 } },
    ]);
    const events = runScenario(reg, (eng) => {
      eng.loadScenario("effects");
      eng.placeTower("archer", { x: 4, y: 0 });
      eng.sendNextWave();
    }, 20);
    const e = findFirst(events, "projectileExpired");
    expect(e).toMatchObject({
      kind: "projectileExpired",
      tick: expect.any(Number),
      projectile: expect.any(String),
      reason: expect.stringMatching(/max-range|target-lost/),
    });
  });
});

// ---------------------------------------------------------------------------
// Guard events
// ---------------------------------------------------------------------------
describe("game-event-payloads: guard events", () => {
  it("guardSpawned — payload shape", () => {
    const reg = buildBarracksRegistry();
    const engine = createEngine(reg, { plugins: builtInBundle, seed: 1 });
    const events: GameEvent[] = [];
    engine.onEvent((e) => events.push(e));
    engine.loadScenario("s");
    engine.placeTower("barracks", { x: 1, y: 1 });
    engine.dispose();

    const e = findFirst(events, "guardSpawned");
    expect(e).toMatchObject({
      kind: "guardSpawned",
      tick: 0,
      guard: expect.any(String),
      tower: expect.any(String),
      archetype: "guard-footman",
      position: { x: expect.any(Number), y: expect.any(Number) },
    });
  });

  it("guardDied — payload shape", () => {
    // Enemy deals enough damage to kill the guard.
    const reg = buildBarracksRegistry();
    (reg.summons as Record<string, Record<string, unknown>>)["guard-footman"]!.hp = 1;
    const events = runScenario(reg, (eng) => {
      eng.loadScenario("s");
      eng.placeTower("barracks", { x: 1, y: 1 });
      eng.sendNextWave();
    }, 100);
    const e = findFirst(events, "guardDied");
    expect(e).toMatchObject({
      kind: "guardDied",
      tick: expect.any(Number),
      guard: expect.any(String),
      tower: expect.any(String),
    });
  });

  it("guardDespawned — payload shape (tower sold)", () => {
    const reg = buildBarracksRegistry();
    const engine = createEngine(reg, { plugins: builtInBundle, seed: 1 });
    const events: GameEvent[] = [];
    engine.onEvent((e) => events.push(e));
    engine.loadScenario("s");
    const placed = engine.placeTower("barracks", { x: 1, y: 1 });
    expect(placed.ok).toBe(true);
    if (placed.ok) engine.sellTower((placed.effect as { entityId: string }).entityId);
    engine.tick(0.1);
    engine.dispose();

    const e = findFirst(events, "guardDespawned");
    expect(e).toMatchObject({
      kind: "guardDespawned",
      tick: expect.any(Number),
      guard: expect.any(String),
      tower: expect.any(String),
      reason: "sold",
    });
  });

  it("guardAttacked — payload shape (guard attacks enemy)", () => {
    const reg = buildBarracksRegistry();
    // Place barracks at (1,1), enemy walks to (2,1) start which is within guard range.
    const events = runScenario(reg, (eng) => {
      eng.loadScenario("s");
      eng.placeTower("barracks", { x: 1, y: 1 });
      eng.sendNextWave();
    }, 100);
    const e = findFirst(events, "guardAttacked");
    expect(e).toMatchObject({
      kind: "guardAttacked",
      tick: expect.any(Number),
      guard: expect.any(String),
      enemy: expect.any(String),
      attackId: "stab",
    });
  });

  it("enemyAttacked — payload shape (enemy attacks guard)", () => {
    const reg = buildBarracksRegistry();
    const events = runScenario(reg, (eng) => {
      eng.loadScenario("s");
      eng.placeTower("barracks", { x: 1, y: 1 });
      eng.sendNextWave();
    }, 100);
    const e = findFirst(events, "enemyAttacked");
    expect(e).toMatchObject({
      kind: "enemyAttacked",
      tick: expect.any(Number),
      enemy: expect.any(String),
      guard: expect.any(String),
      attackId: "punch",
    });
  });

  it("entityHealed — payload shape (wave-clear heal)", () => {
    // Guard that took 1 damage gets healed to full on wave clear.
    const reg = buildBarracksRegistry();
    // Make enemy weak so guard survives but takes 1 hit.
    (reg.enemies as Record<string, Record<string, unknown>>).grunt!.stats =
      { hp: 1, speed: 0, baseDamage: 1 };
    (reg.summons as Record<string, Record<string, unknown>>)["guard-footman"]!.hp = 10;
    (reg.waves as Record<string, Record<string, unknown>>).w1!.groups =
      [{ id: "g1", enemy: "grunt", count: 1, interval: 0, delay: 0 }];
    const events = runScenario(reg, (eng) => {
      eng.loadScenario("s");
      eng.placeTower("barracks", { x: 1, y: 1 });
      eng.sendNextWave();
    }, 100);
    const e = findFirst(events, "entityHealed");
    expect(e).toMatchObject({
      kind: "entityHealed",
      tick: expect.any(Number),
      entity: expect.any(String),
      delta: expect.any(Number),
    });
  });
});

// ---------------------------------------------------------------------------
// Rally point
// ---------------------------------------------------------------------------
describe("game-event-payloads: rally point", () => {
  it("rallyPointMoved — payload shape", () => {
    const reg = buildBarracksRegistry();
    const engine = createEngine(reg, { plugins: builtInBundle, seed: 1 });
    const events: GameEvent[] = [];
    engine.onEvent((e) => events.push(e));
    engine.loadScenario("s");
    const placed = engine.placeTower("barracks", { x: 1, y: 1 });
    expect(placed.ok).toBe(true);
    if (placed.ok) {
      engine.dispatch({
        kind: "moveRallyPoint",
        tower: (placed.effect as { entityId: string }).entityId,
        position: { x: 3, y: 1 },
      });
    }
    engine.tick(0.1);
    engine.dispose();

    const e = findFirst(events, "rallyPointMoved");
    expect(e).toMatchObject({
      kind: "rallyPointMoved",
      tick: 0,
      tower: expect.any(String),
      position: { x: 3, y: 1 },
    });
  });
});

// ---------------------------------------------------------------------------
// REGISTRY_REPLACEMENT
// ---------------------------------------------------------------------------
describe("game-event-payloads: REGISTRY_REPLACEMENT", () => {
  it("REGISTRY_REPLACEMENT — emitted when a plugin replaces a registered targeting strategy", () => {
    const replacerPlugin: Plugin = {
      id: "test/balance-mod",
      register(api) {
        // Re-register "closest-to-base" — already registered by builtInBundle.
        api.registerTargetingStrategy({
          kind: "closest-to-base",
          validate: () => ({ ok: true }),
          select: (ctx) => ctx.eligible[0],
        });
      },
    };

    const reg = buildTracerRegistry();
    const engine = createEngine(reg, {
      plugins: [...builtInBundle, replacerPlugin],
      seed: 0,
    });
    const events: GameEvent[] = [];
    engine.onEvent((e) => events.push(e));
    engine.loadScenario("tracer");
    engine.tick(0.1);
    engine.dispose();

    // builtInBundle itself emits a REGISTRY_REPLACEMENT (attackEffects/projectile-count),
    // so we find the specific event for our balance-mod plugin instead.
    const e = events
      .filter((ev) => ev.kind === "REGISTRY_REPLACEMENT")
      .find((ev) => (ev as Record<string, unknown>)["replacedBy"] === "test/balance-mod");
    expect(e).toMatchObject({
      kind: "REGISTRY_REPLACEMENT",
      tick: 0,
      registry: "targetingStrategies",
      replacedKind: "closest-to-base",
      replacedBy: "test/balance-mod",
      previousPlugin: expect.any(String),
    });
  });
});

// ---------------------------------------------------------------------------
// Coverage meta-check
// ---------------------------------------------------------------------------
describe("game-event-payloads: meta-check", () => {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const SRC_DIR = path.join(__dirname, "../src");

  function extractEmittedKindsFromSrc(): Set<string> {
    const kinds = new Set<string>();

    function scanDir(dir: string): void {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          scanDir(fullPath);
        } else if (entry.name.endsWith(".ts")) {
          const src = fs.readFileSync(fullPath, "utf-8");
          // Match: .emit({ ... kind: "eventName" ... tick:
          // or: pending.push({ ... kind: "eventName" ... tick:
          // Using a multiline pattern to span object literals.
          const re =
            /(?:\.emit|pending\.push)\s*\(\s*\{[^}]*?kind\s*:\s*["']([A-Z_a-z][A-Za-z0-9_]*)["'][^}]*?tick\s*:/gs;
          let m: RegExpExecArray | null;
          while ((m = re.exec(src)) !== null) {
            kinds.add(m[1]!);
          }
        }
      }
    }

    scanDir(SRC_DIR);
    return kinds;
  }

  it("every GameEvent kind emitted in src/ is documented in CANONICAL_EVENT_KINDS", () => {
    const emitted = extractEmittedKindsFromSrc();
    const missing = [...emitted].filter((k) => !CANONICAL_EVENT_KINDS.has(k));
    expect(
      missing,
      `These event kinds appear in src/ emit() calls but are not in CANONICAL_EVENT_KINDS:\n  ${missing.join(", ")}\nAdd them to CANONICAL_EVENT_KINDS and write a payload assertion.`,
    ).toEqual([]);
  });
});
