import {
  PHASE_ORDER,
  type ActionContext,
  type MapFeatureValidationResult,
  type PlacementValidationResult,
  type Plugin,
  type Position,
} from "../../types.js";

interface BlockedRegion {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly kind: string;
}

interface MapPath {
  readonly waypoints: ReadonlyArray<Position>;
}

interface MapData {
  readonly paths?: ReadonlyArray<MapPath>;
  readonly blockedRegions?: ReadonlyArray<BlockedRegion>;
}

function inRegion(p: Position, r: BlockedRegion): boolean {
  return p.x >= r.x && p.x < r.x + r.width && p.y >= r.y && p.y < r.y + r.height;
}

// A point lies on a Path iff it lies on the segment between two consecutive
// (axis-aligned) waypoints. Includes both endpoints — bases and spawn tiles
// are part of their Path and therefore unbuildable.
function onPath(p: Position, paths: ReadonlyArray<MapPath>): boolean {
  for (const path of paths) {
    const wps = path.waypoints;
    for (let i = 1; i < wps.length; i++) {
      const a = wps[i - 1]!;
      const b = wps[i]!;
      if (a.x === b.x && p.x === a.x) {
        const lo = Math.min(a.y, b.y);
        const hi = Math.max(a.y, b.y);
        if (p.y >= lo && p.y <= hi) return true;
      } else if (a.y === b.y && p.y === a.y) {
        const lo = Math.min(a.x, b.x);
        const hi = Math.max(a.x, b.x);
        if (p.x >= lo && p.x <= hi) return true;
      }
    }
  }
  return false;
}

export const mapFeaturesPlugin: Plugin = {
  id: "map-features",
  register(api) {
    // BlockedRegion entities are spawned at scenario load; the component carries the
    // authored `kind` string verbatim so renderers can decorate (US 14). The engine
    // itself only consults x/y/width/height — `kind` is never branched on.
    api.registerComponent({ name: "blockedRegion", writableIn: PHASE_ORDER });

    // MapFeature registry entry for `blocked-region`. The inner `kind` field on each
    // BlockedRegion instance is a renderer hint (pond, mountain, water, …) and may
    // be any string.
    api.registerMapFeature({
      kind: "blocked-region",
      validate(feature: unknown): MapFeatureValidationResult {
        if (typeof feature !== "object" || feature === null) {
          return { ok: false, reason: "BlockedRegion must be an object." };
        }
        const f = feature as Record<string, unknown>;
        for (const numField of ["x", "y", "width", "height"]) {
          if (typeof f[numField] !== "number") {
            return { ok: false, reason: `BlockedRegion missing numeric '${numField}'.` };
          }
        }
        // `kind` is renderer-facing; absent is fine, but if present must be a string.
        if (f.kind !== undefined && typeof f.kind !== "string") {
          return { ok: false, reason: `BlockedRegion 'kind' must be a string when present.` };
        }
        return { ok: true };
      },
    });

    // `free` PlacementMode. Accepts any tile that is (a) not on a Path,
    // (b) not inside any BlockedRegion entity, (c) not already occupied by another Tower.
    api.registerPlacementMode({
      kind: "free",
      validate(position, map, world): PlacementValidationResult {
        const m = map as MapData;
        if (m.paths && onPath(position, m.paths)) {
          return {
            ok: false,
            code: "INVALID_PLACEMENT",
            reason: `(${position.x},${position.y}) lies on a Path.`,
          };
        }
        const regionEntities = world.query({ all: ["blockedRegion"] });
        for (const entity of regionEntities) {
          const r = entity.components.get("blockedRegion") as BlockedRegion | undefined;
          if (r && inRegion(position, r)) {
            return {
              ok: false,
              code: "INVALID_PLACEMENT",
              reason: `(${position.x},${position.y}) lies inside a BlockedRegion.`,
            };
          }
        }
        const towerEntities = world.query({ all: ["tower", "position"] });
        for (const entity of towerEntities) {
          const pos = entity.components.get("position") as Position | undefined;
          if (pos && pos.x === position.x && pos.y === position.y) {
            return {
              ok: false,
              code: "SLOT_OCCUPIED",
              reason: `(${position.x},${position.y}) is already occupied by another Tower.`,
            };
          }
        }
        return { ok: true };
      },
    });

    // Spawn one entity per BlockedRegion at scenario load so renderers can query them
    // via world.query and so the `free` validator can consult a live data source.
    api.onScenarioLoad((ctx: ActionContext) => {
      const scenario = (ctx.registry.scenarios as Record<string, { map: string }>)[
        ctx.scenarioId
      ];
      if (!scenario) return;
      const map = (ctx.registry.maps as Record<string, MapData>)[scenario.map];
      const regions = map?.blockedRegions ?? [];
      regions.forEach((r, i) => {
        ctx.world.spawn(`mapFeature:blockedRegion:${i}`, {
          blockedRegion: {
            x: r.x,
            y: r.y,
            width: r.width,
            height: r.height,
            kind: r.kind,
          },
        });
      });
    });
  },
};
