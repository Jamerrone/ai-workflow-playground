# TargetingStrategy parameterisation and string-shorthand for discriminator objects

## String shorthand for parameterless discriminator objects

Any field whose canonical form is a `kind`-discriminated object accepts a **string shorthand** when the kind needs no other configuration. The Loader normalises strings to `{ kind: <string> }` before validation; plugin validators always receive the object form.

```json
"strategy":    "closest-to-base"                              // shorthand
"strategy":    { "kind": "closest-to-base" }                  // canonical, equivalent
"strategy":    { "kind": "tag-priority", "tag": "boss" }      // necessarily object — has params

"placement":   "free"                                          // shorthand
"placement":   { "kind": "near-path", "maxDistanceFromPath": 2 }  // object

"waveTrigger": "manual"                                        // shorthand
"waveTrigger": { "kind": "hybrid" }                            // equivalent canonical
```

The shorthand applies anywhere a discriminator-object is expected — TargetingStrategy, PlacementMode, WaveTrigger, MapFeature, plugin-registered configs included. Authors who write everything in object form get identical results; the shorthand is purely sugar.

## TargetingStrategy is per-Tower

A Tower carries one TargetingStrategy via its top-level `strategy` field, applied to all of its Attacks for that tick's target selection. The engine's per-tick selection process is:

1. **Target selection** (TargetingStrategy): the Tower picks one target from all in-range eligible Enemies according to its current `strategy`.
2. **Attack selection** (per ADR-0010): the Tower picks the highest-damage Attack whose `targetFilter` accepts that target *and* is off cooldown. Exactly one Attack fires.

If no in-range Enemy matches any Attack's `targetFilter`, no Attack fires that tick. Player override via `engine.overrideTargeting(towerId, strategy)` updates the live Tower's strategy Component; the new strategy takes effect on the next tick's selection.

## Defaults

Towers without an explicit `strategy` field default to `"closest-to-base"`. Built-in strategies: `closest-to-base`, `lowest-hp`, `highest-hp`, `tag-priority` (requires `tag` parameter). Plugin-registered strategies follow the same discriminator-object pattern.

## Rejected alternatives

- **Always-object form, no shorthand.** Consistent but verbose for the common parameterless case; "kind": "closest-to-base" wrappers add noise without adding meaning.
- **Per-Attack TargetingStrategy.** Forces a more granular UI (the player overrides per-Attack rather than per-Tower) and complicates the natural mental model. A plugin can layer per-Attack strategy if a specific game needs it.
