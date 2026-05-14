import { describe, it, expect } from "vitest";
import { createEngine } from "../src/index.js";
import { builtInBundle } from "../src/plugins/builtin/index.js";
import { buildGuardsRegistry } from "./helpers/guards-registry.js";

interface SnapshotEntity {
  readonly id: string;
  readonly components: Record<string, unknown>;
}

function guardEntities(snapshot: string): readonly SnapshotEntity[] {
  const snap = JSON.parse(snapshot) as { entities: SnapshotEntity[] };
  return snap.entities.filter((e) => "guard" in e.components);
}

describe("Guards plugin: tracer bullet — immediate fill on placement", () => {
  it("placing a Barracks with maxCount=3 spawns 3 Guards in the same tick", () => {
    const registry = buildGuardsRegistry();
    const engine = createEngine(registry, { plugins: builtInBundle, seed: 1 });
    engine.loadScenario("guardsScenario");

    const placed = engine.placeTower("barracks", { x: 2, y: 2 });
    expect(placed.ok).toBe(true);

    // Advance one tick so the guard-spawn System runs in the same tick as
    // the placement (per ADR-0011: initial fill is immediate, respawnCooldown
    // applies only after a Guard dies).
    engine.tick(1);

    const guards = guardEntities(engine.snapshot());
    engine.dispose();

    expect(guards).toHaveLength(3);
    for (const g of guards) {
      const archetype = (g.components.guard as { archetype: string }).archetype;
      const position = g.components.position as { x: number; y: number };
      expect(archetype).toBe("footman");
      expect(position).toEqual({ x: 2, y: 2 });
    }
  });

  it("selling the parent Barracks despawns all its Guards in the same tick", () => {
    const registry = buildGuardsRegistry();
    const engine = createEngine(registry, { plugins: builtInBundle, seed: 1 });
    engine.loadScenario("guardsScenario");
    const placed = engine.placeTower("barracks", { x: 2, y: 2 });
    if (!placed.ok) throw new Error("place failed");
    const towerId = (placed.effect as { entityId: string }).entityId;
    engine.tick(1);
    expect(guardEntities(engine.snapshot())).toHaveLength(3);

    const sold = engine.sellTower(towerId);
    expect(sold.ok).toBe(true);

    // No additional tick — despawn must take effect in the same tick as the sale.
    const guards = guardEntities(engine.snapshot());
    engine.dispose();
    expect(guards).toHaveLength(0);
  });

  it("does not exceed maxCount across repeated ticks", () => {
    const registry = buildGuardsRegistry();
    const engine = createEngine(registry, { plugins: builtInBundle, seed: 1 });
    engine.loadScenario("guardsScenario");
    const placed = engine.placeTower("barracks", { x: 2, y: 2 });
    expect(placed.ok).toBe(true);

    for (let i = 0; i < 10; i++) engine.tick(1);

    const guards = guardEntities(engine.snapshot());
    engine.dispose();
    expect(guards).toHaveLength(3);
  });
});
