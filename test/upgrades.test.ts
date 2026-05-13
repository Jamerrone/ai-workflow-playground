import { describe, it, expect } from "vitest";
import { createEngine, buildRegistry } from "../src/index.js";
import type { ConfigRegistry, GameEvent, LoaderInput } from "../src/index.js";
import { builtInBundle } from "../src/plugins/builtin/index.js";
import { buildUpgradesRegistry } from "./helpers/upgrades-registry.js";

function createTestEngine(registry: ConfigRegistry, seed = 1) {
  return createEngine(registry, { plugins: builtInBundle, seed });
}

function getTowerEntityState(snapshot: string, entityId: string): Record<string, unknown> | undefined {
  const snap = JSON.parse(snapshot) as { entities: Array<{ id: string; components: Record<string, unknown> }> };
  const e = snap.entities.find((x) => x.id === entityId);
  return e?.components;
}

function gold(snapshot: string): number {
  const snap = JSON.parse(snapshot) as { entities: Array<{ id: string; components: Record<string, unknown> }> };
  const state = snap.entities.find((x) => x.id === "towers/state");
  return ((state?.components.gold as { amount: number } | undefined)?.amount) ?? 0;
}

describe("upgrades: Loader validation", () => {
  it("recognises 'stat' and 'attackMutation' as upgradeOp kinds", () => {
    const reg = buildUpgradesRegistry();
    const r = buildRegistry(reg as unknown as LoaderInput);
    expect(r.ok).toBe(true);
  });

  it("rejects an upgrade with an unknown op kind", () => {
    const reg = buildUpgradesRegistry();
    (reg.upgrades as any)["bad-op"] = {
      tower: "archer",
      cost: 1,
      ops: [{ kind: "no-such-op" }],
    };
    const r = buildRegistry(reg as unknown as LoaderInput);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => e.code === "UNKNOWN_KIND" && e.actual === "no-such-op")).toBe(true);
    }
  });

  it("rejects a 'stat' op missing both delta and factor", () => {
    const reg = buildUpgradesRegistry();
    (reg.upgrades as any)["bad-stat"] = {
      tower: "archer",
      cost: 1,
      ops: [{ kind: "stat", attackId: "shot", effectId: "main", field: "amount" }],
    };
    const r = buildRegistry(reg as unknown as LoaderInput);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => e.path.startsWith("upgrades.bad-stat.ops[0]"))).toBe(true);
    }
  });

  it("rejects a 'stat' op missing attackId or field", () => {
    const reg = buildUpgradesRegistry();
    (reg.upgrades as any)["bad-stat-noattack"] = {
      tower: "archer",
      cost: 1,
      ops: [{ kind: "stat", field: "amount", delta: 1 }],
    };
    const r = buildRegistry(reg as unknown as LoaderInput);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => e.path.startsWith("upgrades.bad-stat-noattack.ops[0]"))).toBe(true);
    }
  });

  it("rejects an 'attackMutation' op missing 'attackId' or 'field' or 'set'", () => {
    const reg = buildUpgradesRegistry();
    (reg.upgrades as any)["bad-mut"] = {
      tower: "archer",
      cost: 1,
      ops: [{ kind: "attackMutation", field: "cooldown", set: 0.5 }],
    };
    const r = buildRegistry(reg as unknown as LoaderInput);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => e.path.startsWith("upgrades.bad-mut.ops[0]"))).toBe(true);
    }
  });

  it("rejects an upgrade tree with circular prerequisites", () => {
    const reg = buildUpgradesRegistry();
    (reg.upgrades as any).cycleA = {
      tower: "archer",
      cost: 1,
      prerequisites: ["cycleB"],
      ops: [{ kind: "stat", attackId: "shot", effectId: "main", field: "amount", delta: 1 }],
    };
    (reg.upgrades as any).cycleB = {
      tower: "archer",
      cost: 1,
      prerequisites: ["cycleA"],
      ops: [{ kind: "stat", attackId: "shot", effectId: "main", field: "amount", delta: 1 }],
    };
    const r = buildRegistry(reg as unknown as LoaderInput);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => e.code === "UPGRADE_PREREQ_CYCLE")).toBe(true);
    }
  });
});

describe("upgrades: purchaseUpgrade action", () => {
  it("purchaseUpgrade shortcut delegates to dispatch and returns identical results", () => {
    const reg = buildUpgradesRegistry();
    const engine = createTestEngine(reg);
    engine.loadScenario("upgradesScenario");
    const placed = engine.placeTower("archer", { x: 4, y: 0 });
    expect(placed.ok).toBe(true);
    if (!placed.ok) {
      engine.dispose();
      return;
    }
    const towerId = (placed.effect as { entityId: string }).entityId;

    const viaShortcut = engine.purchaseUpgrade(towerId, "damage-boost");

    // Reset on a fresh engine for the dispatch variant.
    const engine2 = createTestEngine(buildUpgradesRegistry());
    engine2.loadScenario("upgradesScenario");
    const placed2 = engine2.placeTower("archer", { x: 4, y: 0 });
    expect(placed2.ok).toBe(true);
    if (!placed2.ok) {
      engine2.dispose();
      return;
    }
    const towerId2 = (placed2.effect as { entityId: string }).entityId;
    const viaDispatch = engine2.dispatch({
      kind: "purchaseUpgrade",
      tower: towerId2,
      upgrade: "damage-boost",
    });

    engine.dispose();
    engine2.dispose();
    expect(viaShortcut.ok).toBe(viaDispatch.ok);
    if (viaShortcut.ok && viaDispatch.ok) {
      // entity ids are identical because tower archetype + position are identical.
      expect(viaShortcut.effect).toEqual(viaDispatch.effect);
    }
  });

  it("success: 'stat' op delta updates the targeted effect's amount observable via world.query", () => {
    const reg = buildUpgradesRegistry();
    const engine = createTestEngine(reg);
    engine.loadScenario("upgradesScenario");
    const placed = engine.placeTower("archer", { x: 4, y: 0 });
    if (!placed.ok) throw new Error("place failed");
    const towerId = (placed.effect as { entityId: string }).entityId;

    const r = engine.purchaseUpgrade(towerId, "damage-boost");
    const snap = engine.snapshot();
    engine.dispose();

    expect(r.ok).toBe(true);
    const comps = getTowerEntityState(snap, towerId);
    expect(comps).toBeDefined();
    const attacks = comps!.attacks as Array<{
      effects: Array<{ id: string; stats: { amount: number } }>;
    }>;
    const main = attacks[0]!.effects.find((e) => e.id === "main")!;
    expect(main.stats.amount).toBe(5 + 10);
  });

  it("success: 'stat' op with effectId updates the scoped effect's stat", () => {
    const reg = buildUpgradesRegistry();
    const engine = createTestEngine(reg);
    engine.loadScenario("upgradesScenario");
    const placed = engine.placeTower("archer", { x: 4, y: 0 });
    if (!placed.ok) throw new Error("place failed");
    const towerId = (placed.effect as { entityId: string }).entityId;
    engine.purchaseUpgrade(towerId, "branch-a"); // delta +2 on effect main amount

    const snap = engine.snapshot();
    engine.dispose();
    const comps = getTowerEntityState(snap, towerId)!;
    const attacks = comps.attacks as Array<{
      effects: Array<{ id: string; stats: { amount: number } }>;
    }>;
    const main = attacks[0]!.effects.find((e) => e.id === "main")!;
    expect(main.stats.amount).toBe(5 + 2);
  });

  it("success: 'stat' op with factor multiplies the existing value", () => {
    const reg = buildUpgradesRegistry();
    const engine = createTestEngine(reg);
    engine.loadScenario("upgradesScenario");
    const placed = engine.placeTower("archer", { x: 4, y: 0 });
    if (!placed.ok) throw new Error("place failed");
    const towerId = (placed.effect as { entityId: string }).entityId;
    // damage-boost (+10 delta) → effect.main.amount=15. needs-boost (factor 2) → 30.
    expect(engine.purchaseUpgrade(towerId, "damage-boost").ok).toBe(true);
    expect(engine.purchaseUpgrade(towerId, "needs-boost").ok).toBe(true);

    const snap = engine.snapshot();
    engine.dispose();
    const comps = getTowerEntityState(snap, towerId)!;
    const attacks = comps.attacks as Array<{
      effects: Array<{ id: string; stats: { amount: number } }>;
    }>;
    const main = attacks[0]!.effects.find((e) => e.id === "main")!;
    expect(main.stats.amount).toBe(30);
  });

  it("success: 'attackMutation' op replaces a named field on the targeted attack", () => {
    const reg = buildUpgradesRegistry();
    const engine = createTestEngine(reg);
    engine.loadScenario("upgradesScenario");
    const placed = engine.placeTower("archer", { x: 4, y: 0 });
    if (!placed.ok) throw new Error("place failed");
    const towerId = (placed.effect as { entityId: string }).entityId;

    const r = engine.purchaseUpgrade(towerId, "rapid-fire");
    expect(r.ok).toBe(true);
    const snap = engine.snapshot();
    engine.dispose();
    const comps = getTowerEntityState(snap, towerId)!;
    const attacks = comps.attacks as Array<{ stats: { cooldown: number } }>;
    expect(attacks[0]!.stats.cooldown).toBe(0.25);
  });

  it("'attackMutation' targets a specific effect by effectId when present", () => {
    const reg = buildUpgradesRegistry();
    (reg.upgrades as any)["effect-mut"] = {
      tower: "archer",
      cost: 5,
      ops: [
        { kind: "attackMutation", attackId: "shot", effectId: "main", field: "amount", set: 99 },
      ],
    };
    (reg.towers as any).archer.upgradeTree.push("effect-mut");

    const engine = createTestEngine(reg);
    engine.loadScenario("upgradesScenario");
    const placed = engine.placeTower("archer", { x: 4, y: 0 });
    if (!placed.ok) throw new Error("place failed");
    const towerId = (placed.effect as { entityId: string }).entityId;
    const r = engine.purchaseUpgrade(towerId, "effect-mut");
    expect(r.ok).toBe(true);
    const snap = engine.snapshot();
    engine.dispose();
    const comps = getTowerEntityState(snap, towerId)!;
    const attacks = comps.attacks as Array<{
      effects: Array<{ id: string; stats: { amount: number } }>;
    }>;
    const main = attacks[0]!.effects.find((e) => e.id === "main")!;
    expect(main.stats.amount).toBe(99);
  });

  it("deducts gold on successful purchase and emits goldChanged + upgradePurchased", () => {
    const reg = buildUpgradesRegistry();
    const events: GameEvent[] = [];
    const engine = createTestEngine(reg);
    engine.onEvent((e) => events.push(e));
    engine.loadScenario("upgradesScenario");
    const placed = engine.placeTower("archer", { x: 4, y: 0 });
    if (!placed.ok) throw new Error("place failed");
    const towerId = (placed.effect as { entityId: string }).entityId;
    const startGold = gold(engine.snapshot()); // starting gold - tower cost
    const r = engine.purchaseUpgrade(towerId, "damage-boost");
    expect(r.ok).toBe(true);
    const endGold = gold(engine.snapshot());
    engine.dispose();
    expect(endGold).toBe(startGold - 30);
    const purchased = events.find((e) => e.kind === "upgradePurchased");
    expect(purchased).toBeDefined();
    expect(purchased!.tower).toBe(towerId);
    expect(purchased!.upgrade).toBe("damage-boost");
    expect(purchased!.delta).toBe(-30);
    expect(typeof purchased!.tick).toBe("number");
    const gc = events.filter((e) => e.kind === "goldChanged");
    // One from placement (-10), one from purchase (-30).
    expect(gc.length).toBeGreaterThanOrEqual(2);
    expect(gc[gc.length - 1]!.delta).toBe(-30);
  });
});

describe("upgrades: failure codes", () => {
  it("INSUFFICIENT_GOLD when current gold is below cost", () => {
    const reg = buildUpgradesRegistry();
    (reg.scenarios as any).upgradesScenario.gameRuleOverrides.startingGold = 11; // covers tower + 1
    const engine = createTestEngine(reg);
    engine.loadScenario("upgradesScenario");
    const placed = engine.placeTower("archer", { x: 4, y: 0 });
    if (!placed.ok) throw new Error("place failed");
    const towerId = (placed.effect as { entityId: string }).entityId;
    const r = engine.purchaseUpgrade(towerId, "damage-boost"); // costs 30
    engine.dispose();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("INSUFFICIENT_GOLD");
  });

  it("UNKNOWN_TOWER when towerId is not a placed Tower entity", () => {
    const reg = buildUpgradesRegistry();
    const engine = createTestEngine(reg);
    engine.loadScenario("upgradesScenario");
    const r = engine.purchaseUpgrade("tower:archer:99,99", "damage-boost");
    engine.dispose();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("UNKNOWN_TOWER");
  });

  it("UNKNOWN_UPGRADE when upgradeId is not in the Tower's upgradeTree", () => {
    const reg = buildUpgradesRegistry();
    const engine = createTestEngine(reg);
    engine.loadScenario("upgradesScenario");
    const placed = engine.placeTower("archer", { x: 4, y: 0 });
    if (!placed.ok) throw new Error("place failed");
    const towerId = (placed.effect as { entityId: string }).entityId;
    const r = engine.purchaseUpgrade(towerId, "phantom-upgrade");
    engine.dispose();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("UNKNOWN_UPGRADE");
  });

  it("PREREQUISITES_NOT_MET when a required upgrade is not yet purchased", () => {
    const reg = buildUpgradesRegistry();
    const engine = createTestEngine(reg);
    engine.loadScenario("upgradesScenario");
    const placed = engine.placeTower("archer", { x: 4, y: 0 });
    if (!placed.ok) throw new Error("place failed");
    const towerId = (placed.effect as { entityId: string }).entityId;
    const r = engine.purchaseUpgrade(towerId, "needs-boost");
    engine.dispose();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("PREREQUISITES_NOT_MET");
  });

  it("succeeds when prerequisites are purchased in order", () => {
    const reg = buildUpgradesRegistry();
    const engine = createTestEngine(reg);
    engine.loadScenario("upgradesScenario");
    const placed = engine.placeTower("archer", { x: 4, y: 0 });
    if (!placed.ok) throw new Error("place failed");
    const towerId = (placed.effect as { entityId: string }).entityId;
    const a = engine.purchaseUpgrade(towerId, "damage-boost");
    const b = engine.purchaseUpgrade(towerId, "needs-boost");
    engine.dispose();
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
  });

  it("EXCLUSIVE_GROUP_LOCKED when a sibling in the same group is already purchased", () => {
    const reg = buildUpgradesRegistry();
    const engine = createTestEngine(reg);
    engine.loadScenario("upgradesScenario");
    const placed = engine.placeTower("archer", { x: 4, y: 0 });
    if (!placed.ok) throw new Error("place failed");
    const towerId = (placed.effect as { entityId: string }).entityId;
    expect(engine.purchaseUpgrade(towerId, "branch-a").ok).toBe(true);
    const r = engine.purchaseUpgrade(towerId, "branch-b");
    engine.dispose();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("EXCLUSIVE_GROUP_LOCKED");
  });

  it("siblings in different exclusiveGroups are unaffected", () => {
    const reg = buildUpgradesRegistry();
    (reg.upgrades as any)["other-branch-a"] = {
      tower: "archer",
      cost: 5,
      exclusiveGroup: "other",
      ops: [{ kind: "stat", attackId: "shot", effectId: "main", field: "amount", delta: 1 }],
    };
    (reg.towers as any).archer.upgradeTree.push("other-branch-a");
    const engine = createTestEngine(reg);
    engine.loadScenario("upgradesScenario");
    const placed = engine.placeTower("archer", { x: 4, y: 0 });
    if (!placed.ok) throw new Error("place failed");
    const towerId = (placed.effect as { entityId: string }).entityId;
    expect(engine.purchaseUpgrade(towerId, "branch-a").ok).toBe(true);
    expect(engine.purchaseUpgrade(towerId, "other-branch-a").ok).toBe(true);
    engine.dispose();
  });

  it("does not deduct gold on a failed purchase", () => {
    const reg = buildUpgradesRegistry();
    const engine = createTestEngine(reg);
    engine.loadScenario("upgradesScenario");
    const placed = engine.placeTower("archer", { x: 4, y: 0 });
    if (!placed.ok) throw new Error("place failed");
    const towerId = (placed.effect as { entityId: string }).entityId;
    const before = gold(engine.snapshot());
    const r = engine.purchaseUpgrade(towerId, "phantom-upgrade");
    const after = gold(engine.snapshot());
    engine.dispose();
    expect(r.ok).toBe(false);
    expect(after).toBe(before);
  });

  it("buying the same upgrade twice fails the second time as EXCLUSIVE_GROUP_LOCKED or UNKNOWN_UPGRADE", () => {
    const reg = buildUpgradesRegistry();
    const engine = createTestEngine(reg);
    engine.loadScenario("upgradesScenario");
    const placed = engine.placeTower("archer", { x: 4, y: 0 });
    if (!placed.ok) throw new Error("place failed");
    const towerId = (placed.effect as { entityId: string }).entityId;
    expect(engine.purchaseUpgrade(towerId, "damage-boost").ok).toBe(true);
    const second = engine.purchaseUpgrade(towerId, "damage-boost");
    engine.dispose();
    expect(second.ok).toBe(false);
    if (!second.ok) {
      // The handler treats an already-purchased upgrade as forbidden.
      expect(["UPGRADE_ALREADY_PURCHASED", "EXCLUSIVE_GROUP_LOCKED"]).toContain(second.code);
    }
  });
});

describe("upgrades: live-fire integration", () => {
  it("after 'attackMutation' lowers cooldown, the tower fires more often", () => {
    const reg = buildUpgradesRegistry();
    (reg.enemies as any).grunt.stats.speed = 0;
    (reg.enemies as any).grunt.stats.hp = 1000;
    const events: GameEvent[] = [];
    const engine = createTestEngine(reg);
    engine.onEvent((e) => events.push(e));
    engine.loadScenario("upgradesScenario");
    const placed = engine.placeTower("archer", { x: 4, y: 0 });
    if (!placed.ok) throw new Error("place failed");
    const towerId = (placed.effect as { entityId: string }).entityId;

    engine.purchaseUpgrade(towerId, "rapid-fire");

    engine.sendNextWave();
    engine.tick(0.3); // cooldown 0.25 satisfied
    engine.tick(0.3);
    engine.dispose();
    const fires = events.filter((e) => e.kind === "towerFired");
    // With cooldown 0.25, two ticks at 0.3 should each fire (cooldown elapses in between).
    expect(fires.length).toBeGreaterThanOrEqual(2);
  });

  it("effectId-scoped stat op increases the damage actually applied on next fire", () => {
    const reg = buildUpgradesRegistry();
    (reg.enemies as any).grunt.stats.speed = 0;
    (reg.enemies as any).grunt.stats.hp = 1000;
    const events: GameEvent[] = [];
    const engine = createTestEngine(reg);
    engine.onEvent((e) => events.push(e));
    engine.loadScenario("upgradesScenario");
    const placed = engine.placeTower("archer", { x: 4, y: 0 });
    if (!placed.ok) throw new Error("place failed");
    const towerId = (placed.effect as { entityId: string }).entityId;
    engine.purchaseUpgrade(towerId, "branch-a"); // +2 to effect main amount → 7

    engine.sendNextWave();
    engine.tick(0.1);
    engine.dispose();
    const dmg = events.find((e) => e.kind === "damageApplied");
    expect(dmg).toBeDefined();
    expect(dmg!.amount).toBe(7);
  });
});
