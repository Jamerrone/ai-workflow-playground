import { describe, it, expect } from "vitest";
import { WorldImpl } from "../src/kernel/world.js";
import type { Position } from "../src/index.js";
import type { PlacementModeDef } from "../src/types.js";
import {
  validateRallyPoint,
  pathContainsPosition,
  type RallyPointMapShape,
} from "../src/plugins/builtin/rally-point.js";

function fixedPlacementMode(): PlacementModeDef {
  return {
    kind: "fixed",
    validate(position: Position, map: unknown) {
      const slots = (map as { towerSlots?: ReadonlyArray<Position> }).towerSlots ?? [];
      const hit = slots.some((s) => s.x === position.x && s.y === position.y);
      return hit ? { ok: true } : { ok: false, reason: "not a slot" };
    },
  };
}

function freePlacementMode(): PlacementModeDef {
  return {
    kind: "free",
    validate() {
      return { ok: true };
    },
  };
}

function buildContext(
  mapOverrides: Partial<RallyPointMapShape> & {
    towerSlots?: ReadonlyArray<Position>;
  } = {},
) {
  const world = new WorldImpl();
  const map: RallyPointMapShape & { towerSlots?: ReadonlyArray<Position> } = {
    placementMode: { kind: "fixed" },
    bases: [],
    paths: [],
    towerSlots: [{ x: 1, y: 1 }],
    ...mapOverrides,
  };
  const placementModes = new Map<string, PlacementModeDef>([
    ["fixed", fixedPlacementMode()],
    ["free", freePlacementMode()],
  ]);
  world.spawn("tower:barracks", {
    tower: { archetype: "barracks" },
    position: { x: 1, y: 1 },
  });
  return { world, map, placementModes };
}

describe("validateRallyPoint", () => {
  it("returns ok for a position on a Path tile within range", () => {
    const { world, map, placementModes } = buildContext({
      paths: [{ waypoints: [{ x: 2, y: 1 }, { x: 4, y: 1 }] }],
    });
    const result = validateRallyPoint({
      position: { x: 3, y: 1 },
      towerPosition: { x: 1, y: 1 },
      towerId: "tower:barracks",
      rallyPointRange: 4,
      map,
      world,
      placementModes,
    });
    expect(result.ok).toBe(true);
  });

  it("returns ok for a position on a placement-mode-valid tile within range", () => {
    const { world, map, placementModes } = buildContext({
      towerSlots: [
        { x: 1, y: 1 },
        { x: 2, y: 1 },
      ],
    });
    const result = validateRallyPoint({
      position: { x: 2, y: 1 },
      towerPosition: { x: 1, y: 1 },
      towerId: "tower:barracks",
      rallyPointRange: 4,
      map,
      world,
      placementModes,
    });
    expect(result.ok).toBe(true);
  });

  it("returns out-of-range when destination exceeds rallyPointRange (Euclidean)", () => {
    const { world, map, placementModes } = buildContext();
    const result = validateRallyPoint({
      position: { x: 5, y: 5 },
      towerPosition: { x: 1, y: 1 },
      towerId: "tower:barracks",
      rallyPointRange: 4,
      map,
      world,
      placementModes,
    });
    expect(result).toMatchObject({ ok: false, reason: "out-of-range" });
  });

  it("returns base-tile when destination is a Base tile", () => {
    const { world, map, placementModes } = buildContext({
      bases: [{ position: { x: 2, y: 1 } }],
    });
    const result = validateRallyPoint({
      position: { x: 2, y: 1 },
      towerPosition: { x: 1, y: 1 },
      towerId: "tower:barracks",
      rallyPointRange: 4,
      map,
      world,
      placementModes,
    });
    expect(result).toMatchObject({ ok: false, reason: "base-tile" });
  });

  it("returns tower-occupied when another Tower sits on the destination", () => {
    const { world, map, placementModes } = buildContext({
      towerSlots: [
        { x: 1, y: 1 },
        { x: 3, y: 1 },
      ],
    });
    world.spawn("tower:other", {
      tower: { archetype: "plain" },
      position: { x: 3, y: 1 },
    });
    const result = validateRallyPoint({
      position: { x: 3, y: 1 },
      towerPosition: { x: 1, y: 1 },
      towerId: "tower:barracks",
      rallyPointRange: 4,
      map,
      world,
      placementModes,
    });
    expect(result).toMatchObject({ ok: false, reason: "tower-occupied" });
  });

  it("does not flag the tower being validated as 'occupying' its own destination", () => {
    const { world, map, placementModes } = buildContext();
    const result = validateRallyPoint({
      position: { x: 1, y: 1 },
      towerPosition: { x: 1, y: 1 },
      towerId: "tower:barracks",
      rallyPointRange: 4,
      map,
      world,
      placementModes,
    });
    expect(result.ok).toBe(true);
  });

  it("returns blocked-region when destination is inside a BlockedRegion", () => {
    const { world, map, placementModes } = buildContext({
      placementMode: { kind: "free" },
    });
    world.spawn("blocked:1", {
      blockedRegion: { x: 2, y: 0, w: 2, h: 2 },
    });
    const result = validateRallyPoint({
      position: { x: 2, y: 1 },
      towerPosition: { x: 1, y: 1 },
      towerId: "tower:barracks",
      rallyPointRange: 4,
      map,
      world,
      placementModes,
    });
    expect(result).toMatchObject({ ok: false, reason: "blocked-region" });
  });

  it("returns not-placeable when destination is neither on a Path nor placement-mode-valid", () => {
    const { world, map, placementModes } = buildContext();
    const result = validateRallyPoint({
      position: { x: 2, y: 2 },
      towerPosition: { x: 1, y: 1 },
      towerId: "tower:barracks",
      rallyPointRange: 4,
      map,
      world,
      placementModes,
    });
    expect(result).toMatchObject({ ok: false, reason: "not-placeable" });
  });

  it("checks distance before tile-type — out-of-range wins over base-tile", () => {
    const { world, map, placementModes } = buildContext({
      bases: [{ position: { x: 10, y: 10 } }],
    });
    const result = validateRallyPoint({
      position: { x: 10, y: 10 },
      towerPosition: { x: 1, y: 1 },
      towerId: "tower:barracks",
      rallyPointRange: 4,
      map,
      world,
      placementModes,
    });
    expect(result).toMatchObject({ ok: false, reason: "out-of-range" });
  });
});

describe("pathContainsPosition", () => {
  it("returns true for a position on a horizontal segment", () => {
    expect(
      pathContainsPosition({ x: 3, y: 1 }, [
        { x: 2, y: 1 },
        { x: 4, y: 1 },
      ]),
    ).toBe(true);
  });

  it("returns true for a position on a vertical segment", () => {
    expect(
      pathContainsPosition({ x: 2, y: 3 }, [
        { x: 2, y: 1 },
        { x: 2, y: 5 },
      ]),
    ).toBe(true);
  });

  it("returns false when the position is off the path", () => {
    expect(
      pathContainsPosition({ x: 3, y: 2 }, [
        { x: 2, y: 1 },
        { x: 4, y: 1 },
      ]),
    ).toBe(false);
  });
});
