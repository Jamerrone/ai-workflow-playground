import { describe, it, expect } from "vitest";
import { createEngine } from "../src/index.js";
import type { ConfigRegistry, GameEvent } from "../src/index.js";
import { builtInBundle } from "../src/plugins/builtin/index.js";
import { buildUpgradesRegistry } from "./helpers/upgrades-registry.js";

function createTestEngine(registry: ConfigRegistry, seed = 1) {
  return createEngine(registry, { plugins: builtInBundle, seed });
}

function gold(snapshot: string): number {
  const snap = JSON.parse(snapshot) as { entities: Array<{ id: string; components: Record<string, unknown> }> };
  const state = snap.entities.find((x) => x.id === "towers/state");
  return ((state?.components.gold as { amount: number } | undefined)?.amount) ?? 0;
}

function entityIds(snapshot: string): string[] {
  const snap = JSON.parse(snapshot) as { entities: Array<{ id: string }> };
  return snap.entities.map((e) => e.id);
}

describe("sellTower: shortcut + dispatch parity", () => {
  it("sellTower shortcut delegates to dispatch and returns identical results", () => {
    const regA = buildUpgradesRegistry();
    const engineA = createTestEngine(regA);
    engineA.loadScenario("upgradesScenario");
    const placedA = engineA.placeTower("archer", { x: 4, y: 0 });
    if (!placedA.ok) throw new Error("place failed");
    const towerIdA = (placedA.effect as { entityId: string }).entityId;
    const viaShortcut = engineA.sellTower(towerIdA);
    engineA.dispose();

    const regB = buildUpgradesRegistry();
    const engineB = createTestEngine(regB);
    engineB.loadScenario("upgradesScenario");
    const placedB = engineB.placeTower("archer", { x: 4, y: 0 });
    if (!placedB.ok) throw new Error("place failed");
    const towerIdB = (placedB.effect as { entityId: string }).entityId;
    const viaDispatch = engineB.dispatch({ kind: "sellTower", tower: towerIdB });
    engineB.dispose();

    expect(viaShortcut.ok).toBe(viaDispatch.ok);
    if (viaShortcut.ok && viaDispatch.ok) {
      expect(viaShortcut.effect).toEqual(viaDispatch.effect);
    }
  });
});

describe("sellTower: refund math (defaultSellRefundPercent)", () => {
  it("refund = floor((towerCost + sum(upgradeCosts)) * defaultSellRefundPercent) with default 0.7", () => {
    const reg = buildUpgradesRegistry();
    const engine = createTestEngine(reg);
    engine.loadScenario("upgradesScenario");
    const placed = engine.placeTower("archer", { x: 4, y: 0 });
    if (!placed.ok) throw new Error("place failed");
    const towerId = (placed.effect as { entityId: string }).entityId;
    expect(engine.purchaseUpgrade(towerId, "damage-boost").ok).toBe(true); // cost 30
    expect(engine.purchaseUpgrade(towerId, "rapid-fire").ok).toBe(true);   // cost 50
    const beforeSell = gold(engine.snapshot());
    const r = engine.sellTower(towerId);
    const afterSell = gold(engine.snapshot());
    engine.dispose();
    expect(r.ok).toBe(true);
    // archer cost=10, damage-boost=30, rapid-fire=50 → total=90. 90 * 0.7 = 63.
    expect(afterSell - beforeSell).toBe(63);
  });

  it("refund of just the tower cost when no upgrades are purchased", () => {
    const reg = buildUpgradesRegistry();
    const engine = createTestEngine(reg);
    engine.loadScenario("upgradesScenario");
    const placed = engine.placeTower("archer", { x: 4, y: 0 });
    if (!placed.ok) throw new Error("place failed");
    const towerId = (placed.effect as { entityId: string }).entityId;
    const beforeSell = gold(engine.snapshot());
    const r = engine.sellTower(towerId);
    const afterSell = gold(engine.snapshot());
    engine.dispose();
    expect(r.ok).toBe(true);
    // 10 * 0.7 = 7
    expect(afterSell - beforeSell).toBe(7);
  });

  it("scenario gameRuleOverrides.defaultSellRefundPercent of 0.5 is respected", () => {
    const reg = buildUpgradesRegistry();
    (reg.scenarios as any).upgradesScenario.gameRuleOverrides.defaultSellRefundPercent = 0.5;
    const engine = createTestEngine(reg);
    engine.loadScenario("upgradesScenario");
    const placed = engine.placeTower("archer", { x: 4, y: 0 });
    if (!placed.ok) throw new Error("place failed");
    const towerId = (placed.effect as { entityId: string }).entityId;
    expect(engine.purchaseUpgrade(towerId, "damage-boost").ok).toBe(true); // cost 30
    const beforeSell = gold(engine.snapshot());
    const r = engine.sellTower(towerId);
    const afterSell = gold(engine.snapshot());
    engine.dispose();
    expect(r.ok).toBe(true);
    // (10 + 30) * 0.5 = 20
    expect(afterSell - beforeSell).toBe(20);
  });

  it("refund is floored to an integer", () => {
    const reg = buildUpgradesRegistry();
    (reg.scenarios as any).upgradesScenario.gameRuleOverrides.defaultSellRefundPercent = 0.33;
    const engine = createTestEngine(reg);
    engine.loadScenario("upgradesScenario");
    const placed = engine.placeTower("archer", { x: 4, y: 0 });
    if (!placed.ok) throw new Error("place failed");
    const towerId = (placed.effect as { entityId: string }).entityId;
    const beforeSell = gold(engine.snapshot());
    const r = engine.sellTower(towerId);
    const afterSell = gold(engine.snapshot());
    engine.dispose();
    expect(r.ok).toBe(true);
    // 10 * 0.33 = 3.3 → floor = 3
    expect(afterSell - beforeSell).toBe(3);
  });
});

describe("sellTower: side effects", () => {
  it("despawns the Tower entity", () => {
    const reg = buildUpgradesRegistry();
    const engine = createTestEngine(reg);
    engine.loadScenario("upgradesScenario");
    const placed = engine.placeTower("archer", { x: 4, y: 0 });
    if (!placed.ok) throw new Error("place failed");
    const towerId = (placed.effect as { entityId: string }).entityId;
    expect(entityIds(engine.snapshot())).toContain(towerId);
    expect(engine.sellTower(towerId).ok).toBe(true);
    const ids = entityIds(engine.snapshot());
    engine.dispose();
    expect(ids).not.toContain(towerId);
  });

  it("frees the slot so the same position accepts a new placeTower", () => {
    const reg = buildUpgradesRegistry();
    const engine = createTestEngine(reg);
    engine.loadScenario("upgradesScenario");
    const placed = engine.placeTower("archer", { x: 4, y: 0 });
    if (!placed.ok) throw new Error("place failed");
    const towerId = (placed.effect as { entityId: string }).entityId;
    expect(engine.sellTower(towerId).ok).toBe(true);
    const replaced = engine.placeTower("archer", { x: 4, y: 0 });
    engine.dispose();
    expect(replaced.ok).toBe(true);
  });
});

describe("sellTower: events", () => {
  it("emits towerSold with tick, tower, refund payload", () => {
    const reg = buildUpgradesRegistry();
    const events: GameEvent[] = [];
    const engine = createTestEngine(reg);
    engine.onEvent((e) => events.push(e));
    engine.loadScenario("upgradesScenario");
    const placed = engine.placeTower("archer", { x: 4, y: 0 });
    if (!placed.ok) throw new Error("place failed");
    const towerId = (placed.effect as { entityId: string }).entityId;
    engine.sellTower(towerId);
    engine.dispose();
    const sold = events.find((e) => e.kind === "towerSold");
    expect(sold).toBeDefined();
    expect(sold!.tower).toBe(towerId);
    expect(typeof sold!.tick).toBe("number");
    expect(sold!.refund).toBe(7); // floor(10 * 0.7) = 7
  });

  it("fires goldChanged exactly once on sell with the correct delta", () => {
    const reg = buildUpgradesRegistry();
    const events: GameEvent[] = [];
    const engine = createTestEngine(reg);
    engine.loadScenario("upgradesScenario");
    const placed = engine.placeTower("archer", { x: 4, y: 0 });
    if (!placed.ok) throw new Error("place failed");
    const towerId = (placed.effect as { entityId: string }).entityId;
    // Subscribe only after placement so we don't see the place-time goldChanged.
    engine.onEvent((e) => events.push(e));
    engine.sellTower(towerId);
    engine.dispose();
    const gc = events.filter((e) => e.kind === "goldChanged");
    expect(gc.length).toBe(1);
    expect(gc[0]!.delta).toBe(7);
  });
});

describe("sellTower: failure codes", () => {
  it("UNKNOWN_TOWER when towerId is not a placed Tower entity", () => {
    const reg = buildUpgradesRegistry();
    const engine = createTestEngine(reg);
    engine.loadScenario("upgradesScenario");
    const r = engine.sellTower("tower:archer:99,99");
    engine.dispose();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("UNKNOWN_TOWER");
  });

  it("TOWER_ALREADY_SOLD when the same tower is sold twice", () => {
    const reg = buildUpgradesRegistry();
    const engine = createTestEngine(reg);
    engine.loadScenario("upgradesScenario");
    const placed = engine.placeTower("archer", { x: 4, y: 0 });
    if (!placed.ok) throw new Error("place failed");
    const towerId = (placed.effect as { entityId: string }).entityId;
    const first = engine.sellTower(towerId);
    const second = engine.sellTower(towerId);
    engine.dispose();
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.code).toBe("TOWER_ALREADY_SOLD");
  });
});
