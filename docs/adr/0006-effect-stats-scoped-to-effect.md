# AttackEffect stats live on the effect; Upgrades target by `effectId`

Per-effect stats are carried on the effect object itself, not flattened into the parent Attack's `stats` block. A `dot` effect declares its own `damage`, `duration`, `interval`. A `slow` effect declares its own `slowFactor`, `duration`. An Attack may carry multiple AttackEffects of the same `kind`, each with its own `id` and its own stats. Upgrades that want to modify a specific effect's stat target it via an optional `effectId` field on the stat-op:

```json
{ "kind": "stat", "attackId": "arrow", "effectId": "poison",
  "stat": "damage", "delta": 4 }
```

When `effectId` is omitted, the stat-op targets the Attack's own `stats` block.

Chosen over flattening effect stats onto the Attack (`stats.dotDamage`, `stats.dotDuration`, …) because flat naming forecloses:

1. Multiple effects of the same kind on one Attack (bleed + poison, two slows from different sources).
2. Independent plugins adding effects without coordinating stat-name namespaces (two plugins both producing a `slowFactor` collide).
3. Boss / hero / stacking mechanics where the same effect kind is applied many times with distinct configurations.

The cost is one optional `effectId` field on stat-ops. Authors who never use it pay nothing. The Loader's referential-integrity pass surfaces unresolved `effectId` references the same way it surfaces unresolved upgrade prerequisites.

## Consequences

- AttackEffects carry an `id` when they're targeted by upgrades. The `id` is local to its parent Attack; uniqueness is per-Attack, not global.
- The `attackMutation` UpgradeOp gains `op: "addEffect"` and `op: "removeEffect"` variants that operate on the effects array; `op: "modify"` continues to operate on Attack-level fields like `targetFilter`. Stat changes go through the `stat` op, not through `op: "modify"` with a patch.
