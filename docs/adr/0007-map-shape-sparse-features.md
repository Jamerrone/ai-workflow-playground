# Map shape: sparse features on a coordinate plane

A Map is authored as `size` (`width`, `height` in tiles) plus structured feature arrays — `paths`, `bases`, `blockedRegions`, optional `towerSlots`, a `placementMode` discriminator-object, and a `meta` block. There is no literal tile array consumed by the engine; tile painting is renderer-side, carried in `meta` under whatever convention the renderer chooses.

```json
{
  "id": "forest", "kind": "map", "width": 12, "height": 8,
  "placementMode": { "kind": "free" },
  "paths": [
    { "id": "main", "kind": "ground",
      "waypoints": [{"x":0,"y":4},{"x":5,"y":4},{"x":5,"y":2},{"x":11,"y":2}] }
  ],
  "bases": [{ "id": "gate", "position": {"x":11,"y":2} }],
  "blockedRegions": [
    { "x": 3, "y": 6, "width": 2, "height": 2, "kind": "pond" }
  ],
  "meta": { "name": "Forest Path", "tiles": { /* renderer-defined */ } }
}
```

Conventions locked in by this shape:

- **Bases are first-class** with ids; multiple Paths may converge on the same Base by reference. Spawn points are *not* first-class — a Path's first waypoint is its spawn.
- **Waypoints are inline** `{x, y}` objects, not named-referenced. Consecutive waypoints must differ on exactly one axis (no diagonal movement); the Loader enforces this.
- **BlockedRegion `kind`** is a renderer hint; the engine treats every BlockedRegion identically (no tower placement). Multiple BlockedRegions may overlap to express non-rectangular terrain.
- **Renderer-side decoration** (tile art, themes, backgrounds, per-tile painting) lives entirely under `meta`. The engine never reads or validates `meta` contents.
- **Built-in PlacementModes are `fixed` and `free`.** Fancier modes (near-path, zoned, adjacency-restricted, …) are plugin-registered, not engine-built-in.

Chosen over a literal-2D-tile-grid model because the engine consumes path geometry, base positions, and placement constraints — never tile art. A literal grid forces authors to encode multi-path and aerial-path geometry through character codes that don't scale, prevents sub-tile precision (which the engine commits to), and conflates structure with presentation. A separate `meta.tiles` convention gives renderers as much per-tile control as they want, with no engine cost.

## Consequences

- Hand-authoring a non-trivial Map (many paths, lots of slots) is tedious without tooling. We accept this; the alternative is the engine consuming data it doesn't need.
- Two renderers can render the same Map with entirely different art by following different `meta` conventions. Renderers do not coordinate through the engine.
- "Where can towers go?" with built-in modes is binary (any-non-blocked vs. declared slots). Real games wanting "near path" / "in zone" / "non-adjacent" use plugin-registered PlacementModes.
