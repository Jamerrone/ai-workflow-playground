# Plugin-extensible config uses `kind`-discriminator objects, with TS safety via declaration merging

Any config field whose shape is plugin-extensible — PlacementMode, WaveTrigger, AttackEffect, UpgradeOp, MapFeature, TargetingStrategy (when parameterised), and anything else of this family — is authored as an object carrying a `kind` discriminator alongside the kind's own configuration fields:

```json
"placementMode": { "kind": "near-path", "maxDistanceFromPath": 2 }
```

Not as a string-plus-side-config-field (`placementMode: "near-path", placementConfig: {...}`). The discriminator-object form is the same pattern we use for AttackEffects, UpgradeOps, and every other registered kind — symmetry is the point.

## TypeScript safety

The engine exposes an open keyed interface per registry. Built-in plugins and user plugins both contribute via TypeScript's declaration merging — the standard pattern for plugin-extensible TS libraries (TanStack Router, Vue, Drizzle):

```ts
// engine
export interface PlacementModeMap {}
export type PlacementModeConfig = PlacementModeMap[keyof PlacementModeMap];

// plugin (built-in or user)
declare module "@td/engine" {
  interface PlacementModeMap {
    "near-path": { kind: "near-path"; maxDistanceFromPath: number };
  }
}
```

A scenario author writing `MapConfig` in TypeScript gets autocomplete for every imported plugin's registered kinds and a type error on misspelled fields. A plugin not imported is invisible to TS — opt-in, no merging.

## Runtime safety for raw JSON

Plain `.json` files cannot be type-checked by TypeScript. The Loader is the safety net: every plugin registers a runtime validator for each kind it adds; the Loader dispatches by `kind` and rejects malformed entries with a referential, kind-attributing error. IDE-side JSON Schema generated from validators is achievable but lives outside the engine.

## Consequences

- Plugin authors ship `.d.ts` augmentations alongside runtime registration. The plugin authoring guide makes this an explicit step in the worked example.
- The discriminator-object pattern is consistent everywhere a plugin can extend a config field. One mental model.
- Authors who write raw JSON rely on Loader errors for safety; authors who write TS get full editor support.
