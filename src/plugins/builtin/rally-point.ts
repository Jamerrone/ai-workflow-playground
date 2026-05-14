import type { PlacementModeDef, Position } from "../../types.js";
import type { World } from "../../kernel/world.js";

export interface RallyPointMapShape {
  readonly bases?: ReadonlyArray<{ readonly position: Position }>;
  readonly paths?: ReadonlyArray<{ readonly waypoints?: ReadonlyArray<Position> }>;
  readonly placementMode: { readonly kind: string };
}

export type RallyPointFailureReason =
  | "out-of-range"
  | "base-tile"
  | "tower-occupied"
  | "blocked-region"
  | "not-placeable";

export type RallyPointValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: RallyPointFailureReason };

export interface RallyPointValidationInput {
  readonly position: Position;
  readonly towerPosition: Position;
  readonly towerId: string;
  readonly rallyPointRange: number;
  readonly map: RallyPointMapShape;
  readonly world: World;
  readonly placementModes: ReadonlyMap<string, PlacementModeDef>;
}

export function pathContainsPosition(
  pos: Position,
  waypoints: ReadonlyArray<Position>,
): boolean {
  for (let i = 0; i < waypoints.length - 1; i++) {
    const a = waypoints[i]!;
    const b = waypoints[i + 1]!;
    if (a.x === b.x && pos.x === a.x) {
      const lo = Math.min(a.y, b.y);
      const hi = Math.max(a.y, b.y);
      if (pos.y >= lo && pos.y <= hi) return true;
    } else if (a.y === b.y && pos.y === a.y) {
      const lo = Math.min(a.x, b.x);
      const hi = Math.max(a.x, b.x);
      if (pos.x >= lo && pos.x <= hi) return true;
    }
  }
  return false;
}

export function validateRallyPoint(
  input: RallyPointValidationInput,
): RallyPointValidationResult {
  const { position, towerPosition, towerId, rallyPointRange, map, world, placementModes } =
    input;

  const dx = position.x - towerPosition.x;
  const dy = position.y - towerPosition.y;
  if (dx * dx + dy * dy > rallyPointRange * rallyPointRange) {
    return { ok: false, reason: "out-of-range" };
  }

  const onBase = (map.bases ?? []).some(
    (b) => b.position.x === position.x && b.position.y === position.y,
  );
  if (onBase) return { ok: false, reason: "base-tile" };

  const towerOnTile = world
    .query({ all: ["tower", "position"] })
    .some((other) => {
      if (other.id === towerId) return false;
      const p = other.components.get("position") as Position;
      return p.x === position.x && p.y === position.y;
    });
  if (towerOnTile) return { ok: false, reason: "tower-occupied" };

  const onBlocked = world.query({ all: ["blockedRegion"] }).some((be) => {
    const r = be.components.get("blockedRegion") as
      | { x: number; y: number; w: number; h: number }
      | undefined;
    if (!r) return false;
    return (
      position.x >= r.x &&
      position.x < r.x + r.w &&
      position.y >= r.y &&
      position.y < r.y + r.h
    );
  });
  if (onBlocked) return { ok: false, reason: "blocked-region" };

  const onPath = (map.paths ?? []).some((p) =>
    pathContainsPosition(position, p.waypoints ?? []),
  );
  if (onPath) return { ok: true };

  const placementMode = placementModes.get(map.placementMode.kind);
  const placementOk =
    placementMode?.validate(position, map, world).ok ?? false;
  if (placementOk) return { ok: true };

  return { ok: false, reason: "not-placeable" };
}
