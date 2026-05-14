import {
  PHASE_ORDER,
  type ActionContext,
  type MapFeatureValidationResult,
  type PlacementValidationResult,
  type Plugin,
  type Position,
} from "../../types.js";
import { checkKind, requireArray, requireNumber } from "../../loader/validator-helpers.js";
import { isObject } from "../../loader/normalize.js";
import type { BucketValidatorContext } from "../../loader/types.js";

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

const BLOCKED_REGION_NUMERIC_FIELDS = ["x", "y", "width", "height"] as const;

function inRegion(p: Position, r: BlockedRegion): boolean {
  return p.x >= r.x && p.x < r.x + r.width && p.y >= r.y && p.y < r.y + r.height;
}

// Endpoints are inclusive — bases and spawn tiles count as on-Path and are
// therefore unbuildable.
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

function validateMap(ctx: BucketValidatorContext): void {
  const raw = ctx.entry;
  const path = ctx.path;
  requireNumber(ctx, raw, "width", path);
  requireNumber(ctx, raw, "height", path);
  requireArray(ctx, raw, "paths", path);
  requireArray(ctx, raw, "bases", path);
  if (!isObject(raw.placementMode)) {
    ctx.addError({
      severity: "error",
      code: "INVALID_FIELD",
      path: `${path}.placementMode`,
      message: `Map '${ctx.id}' is missing 'placementMode'.`,
      expected: "{ kind: ... }",
      actual: String(raw.placementMode),
    });
  } else {
    checkKind(ctx, "placementMode", raw.placementMode, `${path}.placementMode`);
  }
  if (Array.isArray(raw.paths)) {
    raw.paths.forEach((p, i) => {
      if (!isObject(p)) return;
      const wps = p.waypoints;
      if (!Array.isArray(wps)) return;
      for (let j = 1; j < wps.length; j++) {
        const a = wps[j - 1];
        const b = wps[j];
        if (!isObject(a) || !isObject(b)) continue;
        const dx = (b.x as number) - (a.x as number);
        const dy = (b.y as number) - (a.y as number);
        if (dx !== 0 && dy !== 0) {
          ctx.addError({
            severity: "error",
            code: "INVALID_FIELD",
            path: `${path}.paths[${i}].waypoints[${j}]`,
            message: `Consecutive waypoints must differ on exactly one axis; got diagonal step.`,
            expected: "axis-aligned step (dx==0 XOR dy==0)",
            actual: `(${dx},${dy})`,
            hint: "Break the diagonal into two waypoints.",
          });
        }
      }
    });
  }
}

export const mapFeaturesPlugin: Plugin = {
  id: "map-features",
  register(api) {
    // Map JSON loader validator — placement mode, paths, bases, and the
    // axis-aligned-waypoints invariant. Lives here because map-features is
    // the plugin that ships Map-level concerns (BlockedRegion + the `free`
    // PlacementMode).
    api.registerBucketValidator({ bucket: "maps", validate: validateMap });

    // The component carries the authored `kind` string verbatim so renderers can
    // decorate; the engine itself only consults x/y/width/height.
    api.registerComponent({ name: "blockedRegion", writableIn: PHASE_ORDER });

    api.registerMapFeature({
      kind: "blocked-region",
      validate(feature: unknown): MapFeatureValidationResult {
        if (typeof feature !== "object" || feature === null) {
          return { ok: false, reason: "BlockedRegion must be an object." };
        }
        const f = feature as Record<string, unknown>;
        for (const numField of BLOCKED_REGION_NUMERIC_FIELDS) {
          if (typeof f[numField] !== "number") {
            return { ok: false, reason: `BlockedRegion missing numeric '${numField}'.` };
          }
        }
        // `kind` is a renderer hint (pond, mountain, water, …); absent is fine,
        // but if present must be a string.
        if (f.kind !== undefined && typeof f.kind !== "string") {
          return { ok: false, reason: `BlockedRegion 'kind' must be a string when present.` };
        }
        return { ok: true };
      },
    });

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

    // Spawn one entity per BlockedRegion at scenario load so renderers can
    // discover them via world.query and the `free` validator above can consult
    // a live data source rather than re-reading the map config each placement.
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
