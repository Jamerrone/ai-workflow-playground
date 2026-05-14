import { describe, it, expect } from "vitest";
import { createEngine } from "../src/index.js";
import type { ConfigRegistry } from "../src/index.js";
import { builtInBundle } from "../src/plugins/builtin/index.js";

function createFreeEngine(registry: ConfigRegistry = buildFreePlacementRegistry(), seed = 1) {
  const engine = createEngine(registry, { plugins: builtInBundle, seed });
  engine.loadScenario("free-scenario");
  return engine;
}

function buildFreePlacementRegistry(): ConfigRegistry {
  return {
    components: {},
    entityKinds: {},
    maps: {
      "free-map": {
        width: 6,
        height: 4,
        placementMode: { kind: "free" },
        paths: [
          {
            id: "p1",
            kind: "ground",
            waypoints: [
              { x: 0, y: 1 },
              { x: 5, y: 1 },
            ],
          },
        ],
        bases: [{ id: "b1", position: { x: 5, y: 1 } }],
        blockedRegions: [
          { x: 2, y: 3, width: 2, height: 1, kind: "pond" },
        ],
      },
    },
    towers: {
      archer: {
        cost: 50,
        targeting: { kind: "closest-to-base" },
        attacks: [
          {
            id: "shot",
            stats: { damage: 10, range: 3, cooldown: 0.5 },
            targetFilter: { require: [], exclude: [] },
            effects: [{ kind: "damage", stats: { amount: 10 } }],
          },
        ],
      },
    },
    enemies: {
      grunt: {
        tags: ["ground"],
        stats: { hp: 10, speed: 1, baseDamage: 1 },
        killReward: 10,
      },
    },
    summons: {},
    waves: {
      w1: {
        groups: [{ id: "g1", enemy: "grunt", count: 1, interval: 0, delay: 0 }],
      },
    },
    scenarios: {
      "free-scenario": {
        map: "free-map",
        waves: [{ id: "w1", pathBindings: { g1: "p1" } }],
        waveTrigger: { kind: "manual" },
        gameRuleOverrides: { globalBaseHealth: 10, startingGold: 500 },
      },
    },
    upgrades: {},
    difficulties: {},
    gameRules: {},
  };
}

describe("free PlacementMode", () => {
  it("accepts placement on an empty land tile that is not on a Path and not in a BlockedRegion", () => {
    const engine = createFreeEngine();
    const result = engine.placeTower("archer", { x: 0, y: 0 });
    engine.dispose();
    expect(result.ok).toBe(true);
  });

  it("rejects placement on a Path tile with INVALID_PLACEMENT", () => {
    const engine = createFreeEngine();
    const result = engine.placeTower("archer", { x: 3, y: 1 });
    engine.dispose();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("INVALID_PLACEMENT");
  });

  it("rejects placement on a BlockedRegion tile with INVALID_PLACEMENT", () => {
    const engine = createFreeEngine();
    const result = engine.placeTower("archer", { x: 2, y: 3 });
    engine.dispose();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("INVALID_PLACEMENT");
  });

  it("rejects placement on an already-occupied tile with SLOT_OCCUPIED", () => {
    const engine = createFreeEngine();
    const first = engine.placeTower("archer", { x: 0, y: 0 });
    expect(first.ok).toBe(true);
    const second = engine.placeTower("archer", { x: 0, y: 0 });
    engine.dispose();
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.code).toBe("SLOT_OCCUPIED");
  });

  it("rejects placement at every tile in an L-shaped composition of BlockedRegions", () => {
    // Compose an L: a horizontal bar (y=3, x=1..3) plus a vertical bar (x=1, y=2..3).
    const reg = buildFreePlacementRegistry();
    (reg.maps as any)["free-map"].blockedRegions = [
      { x: 1, y: 3, width: 3, height: 1, kind: "mountain" },
      { x: 1, y: 2, width: 1, height: 2, kind: "water" },
    ];
    const engine = createFreeEngine(reg);
    // Every tile in the L is blocked.
    const lTiles = [
      { x: 1, y: 3 }, { x: 2, y: 3 }, { x: 3, y: 3 },
      { x: 1, y: 2 },
    ];
    for (const t of lTiles) {
      const r = engine.placeTower("archer", t);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("INVALID_PLACEMENT");
    }
    // A non-L tile (off the path and unblocked) is still placeable.
    const okResult = engine.placeTower("archer", { x: 0, y: 0 });
    expect(okResult.ok).toBe(true);
    engine.dispose();
  });

  it("exposes the BlockedRegion `kind` field through world.query", () => {
    // Two regions with different `kind` strings; both should be queryable identically.
    const reg = buildFreePlacementRegistry();
    (reg.maps as any)["free-map"].blockedRegions = [
      { x: 2, y: 3, width: 1, height: 1, kind: "pond" },
      { x: 4, y: 3, width: 1, height: 1, kind: "mountain" },
    ];
    const engine = createFreeEngine(reg);
    const snap = JSON.parse(engine.snapshot()) as {
      entities: Array<{ id: string; components: Record<string, unknown> }>;
    };
    engine.dispose();
    const regions = snap.entities
      .map((e) => e.components.blockedRegion as
        | { x: number; y: number; width: number; height: number; kind: string }
        | undefined)
      .filter((r): r is { x: number; y: number; width: number; height: number; kind: string } =>
        r !== undefined,
      );
    expect(regions).toHaveLength(2);
    const kinds = regions.map((r) => r.kind).sort();
    expect(kinds).toEqual(["mountain", "pond"]);
    // Both kinds block placement uniformly (engine ignores kind).
    const engine2 = createFreeEngine(reg, 2);
    const pondRes = engine2.placeTower("archer", { x: 2, y: 3 });
    const mountainRes = engine2.placeTower("archer", { x: 4, y: 3 });
    engine2.dispose();
    expect(pondRes.ok).toBe(false);
    expect(mountainRes.ok).toBe(false);
    if (!pondRes.ok) expect(pondRes.code).toBe("INVALID_PLACEMENT");
    if (!mountainRes.ok) expect(mountainRes.code).toBe("INVALID_PLACEMENT");
  });

  it("free and fixed PlacementModes coexist; existing fixed-mode behaviour still works", () => {
    // Compose a registry with TWO maps and TWO scenarios — one fixed, one free.
    const reg = buildFreePlacementRegistry();
    (reg.maps as any)["fixed-map"] = {
      width: 5,
      height: 1,
      placementMode: { kind: "fixed" },
      paths: [
        {
          id: "fp",
          kind: "ground",
          waypoints: [
            { x: 0, y: 0 },
            { x: 4, y: 0 },
          ],
        },
      ],
      bases: [{ id: "fb", position: { x: 4, y: 0 } }],
      towerSlots: [{ x: 2, y: 0 }],
    };
    (reg.scenarios as any)["fixed-scenario"] = {
      map: "fixed-map",
      waves: [{ id: "w1", pathBindings: { g1: "fp" } }],
      waveTrigger: { kind: "manual" },
      gameRuleOverrides: { globalBaseHealth: 10, startingGold: 500 },
    };

    // Fixed scenario still uses the slot.
    const fixedEngine = createEngine(reg, { plugins: builtInBundle, seed: 1 });
    fixedEngine.loadScenario("fixed-scenario");
    const onSlot = fixedEngine.placeTower("archer", { x: 2, y: 0 });
    const offSlot = fixedEngine.placeTower("archer", { x: 1, y: 0 });
    fixedEngine.dispose();
    expect(onSlot.ok).toBe(true);
    expect(offSlot.ok).toBe(false);

    // Free scenario uses free-mode rules.
    const freeEngine = createFreeEngine(reg);
    const onLand = freeEngine.placeTower("archer", { x: 0, y: 0 });
    const onPath = freeEngine.placeTower("archer", { x: 3, y: 1 });
    freeEngine.dispose();
    expect(onLand.ok).toBe(true);
    expect(onPath.ok).toBe(false);
  });
});
