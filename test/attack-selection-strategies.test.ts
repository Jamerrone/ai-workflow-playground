import { describe, it, expect } from "vitest";
import { buildRegistry, createEngine } from "../src/index.js";
import type { ConfigRegistry, GameEvent, LoaderInput } from "../src/index.js";
import { builtInBundle } from "../src/plugins/builtin/index.js";
import { buildTracerRegistry } from "./helpers/tracer-registry.js";

function multiAttackRegistry(): ConfigRegistry {
  const reg = buildTracerRegistry();
  // Two attacks on the archer: 'weak' (amount 1) and 'strong' (amount 50).
  // Both share the same range/cooldown so the selection strategy is what differentiates them.
  (reg.towers as any).archer.attacks = [
    {
      id: "weak",
      stats: { range: 3, cooldown: 0.5 },
      targetFilter: { require: [], exclude: [] },
      effects: [{ kind: "damage", id: "d", stats: { amount: 1 } }],
    },
    {
      id: "strong",
      stats: { range: 3, cooldown: 0.5 },
      targetFilter: { require: [], exclude: [] },
      effects: [{ kind: "damage", id: "d", stats: { amount: 50 } }],
    },
  ];
  (reg.enemies as any).grunt.stats.hp = 1000;
  (reg.enemies as any).grunt.stats.speed = 0;
  return reg;
}

describe("AttackSelectionStrategy: declaration-order (default)", () => {
  it("fires the first declared eligible attack when no attackSelection is configured", () => {
    const reg = multiAttackRegistry();
    const engine = createEngine(reg, { plugins: builtInBundle, seed: 1 });
    const fires: GameEvent[] = [];
    engine.on("towerFired", (e) => fires.push(e));
    engine.loadScenario("tracer");
    engine.placeTower("archer", { x: 2, y: 0 });
    engine.sendNextWave();
    engine.tick(0.1);
    engine.dispose();
    expect(fires.length).toBeGreaterThan(0);
    expect(fires[0]!.attackId).toBe("weak");
  });
});

describe("AttackSelectionStrategy: highest-damage", () => {
  it("fires the attack with the largest summed damagePreview across effects", () => {
    const reg = multiAttackRegistry();
    (reg.towers as any).archer.attackSelection = { kind: "highest-damage" };
    const engine = createEngine(reg, { plugins: builtInBundle, seed: 1 });
    const fires: GameEvent[] = [];
    engine.on("towerFired", (e) => fires.push(e));
    engine.loadScenario("tracer");
    engine.placeTower("archer", { x: 2, y: 0 });
    engine.sendNextWave();
    engine.tick(0.1);
    engine.dispose();
    expect(fires.length).toBeGreaterThan(0);
    expect(fires[0]!.attackId).toBe("strong");
  });

  it("dot's damagePreview = damagePerTick * ceil(duration / interval)", () => {
    const reg = buildTracerRegistry();
    // 'a' has plain damage 5; 'b' has dot dealing 2 every 0.5s for 1s = 4 total.
    (reg.towers as any).archer.attacks = [
      {
        id: "a",
        stats: { range: 3, cooldown: 0.5 },
        targetFilter: { require: [], exclude: [] },
        effects: [{ kind: "damage", id: "d", stats: { amount: 5 } }],
      },
      {
        id: "b",
        stats: { range: 3, cooldown: 0.5 },
        targetFilter: { require: [], exclude: [] },
        effects: [
          { kind: "dot", id: "p", stats: { damagePerTick: 2, interval: 0.5, duration: 1 } },
        ],
      },
    ];
    (reg.towers as any).archer.attackSelection = { kind: "highest-damage" };
    (reg.enemies as any).grunt.stats.hp = 1000;
    (reg.enemies as any).grunt.stats.speed = 0;

    const engine = createEngine(reg, { plugins: builtInBundle, seed: 1 });
    const fires: GameEvent[] = [];
    engine.on("towerFired", (e) => fires.push(e));
    engine.loadScenario("tracer");
    engine.placeTower("archer", { x: 2, y: 0 });
    engine.sendNextWave();
    engine.tick(0.1);
    engine.dispose();
    expect(fires.length).toBeGreaterThan(0);
    // damage 5 vs dot 4 → 'a' should win.
    expect(fires[0]!.attackId).toBe("a");
  });
});

describe("Loader: attackSelection validation", () => {
  it("accepts attackSelection: { kind: 'declaration-order' } and 'highest-damage'", () => {
    for (const kind of ["declaration-order", "highest-damage"]) {
      const reg = buildTracerRegistry();
      (reg.towers as any).archer.attackSelection = { kind };
      const r = buildRegistry(reg as unknown as LoaderInput);
      expect(r.ok, `kind '${kind}' should load`).toBe(true);
    }
  });

  it("rejects an unregistered attackSelection kind", () => {
    const reg = buildTracerRegistry();
    (reg.towers as any).archer.attackSelection = { kind: "round-robin" };
    const r = buildRegistry(reg as unknown as LoaderInput);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => e.code === "UNKNOWN_KIND" && e.actual === "round-robin")).toBe(true);
    }
  });

  it("emits a DAMAGE_PREVIEW_MISSING warning when highest-damage tower mounts a non-preview effect", () => {
    const reg = buildTracerRegistry();
    (reg.towers as any).archer.attackSelection = { kind: "highest-damage" };
    // 'slow' has no damagePreview; mounting it on a highest-damage tower trips the warning.
    (reg.towers as any).archer.attacks[0].effects = [
      { kind: "damage", id: "d", stats: { amount: 10 } },
      { kind: "slow", id: "s", stats: { factor: 0.5, duration: 1 } },
    ];
    const r = buildRegistry(reg as unknown as LoaderInput);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const w = r.warnings.find((w) => w.code === "DAMAGE_PREVIEW_MISSING");
      expect(w).toBeDefined();
      expect(w!.actual).toBe("slow");
      expect(w!.message).toContain("archer");
      expect(w!.message).toContain("shot");
    }
  });

  it("emits no DAMAGE_PREVIEW_MISSING warning when attackSelection is declaration-order (default)", () => {
    const reg = buildTracerRegistry();
    (reg.towers as any).archer.attacks[0].effects = [
      { kind: "damage", id: "d", stats: { amount: 10 } },
      { kind: "slow", id: "s", stats: { factor: 0.5, duration: 1 } },
    ];
    const r = buildRegistry(reg as unknown as LoaderInput);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.warnings.find((w) => w.code === "DAMAGE_PREVIEW_MISSING")).toBeUndefined();
    }
  });

  it("damagePreviewKinds option allows plugins to declare additional preview-capable kinds", () => {
    const reg = buildTracerRegistry();
    (reg.towers as any).archer.attackSelection = { kind: "highest-damage" };
    // Pretend 'slow' is preview-capable in this caller's plugin set — no warning expected.
    (reg.towers as any).archer.attacks[0].effects = [
      { kind: "damage", id: "d", stats: { amount: 10 } },
      { kind: "slow", id: "s", stats: { factor: 0.5, duration: 1 } },
    ];
    const r = buildRegistry(reg as unknown as LoaderInput, {
      damagePreviewKinds: new Set(["slow"]),
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.warnings.find((w) => w.code === "DAMAGE_PREVIEW_MISSING")).toBeUndefined();
    }
  });
});
