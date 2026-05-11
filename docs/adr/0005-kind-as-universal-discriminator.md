# `kind` as the universal JSON discriminator

Every registered-thing JSON object uses a `kind` string field as its discriminator. The Loader looks up `kind` in the relevant registry and dispatches to the registered validator. This applies recursively: top-level archetypes (`kind: "tower"`, `kind: "enemy"`), AttackEffects (`kind: "dot"`, `kind: "splash"`), UpgradeOps (`kind: "stat"`, `kind: "attackMutation"`), PlacementModes, WaveTriggers, RewardKinds, MapFeatures, and so on.

Where multiple registered-thing instances appear together (e.g. several UpgradeOps on one Upgrade, several AttackEffects on one Attack), they are carried as a single array — `ops: [...]`, `effects: [...]` — not as separate per-kind arrays. Order is preserved; plugins extend the registry without changing the schema shape.

Chosen over per-kind arrays (`statModifiers: […]`, `attackMutations: […]`, …) because per-kind arrays push plugin extensibility into the schema itself: every new registered kind would add a top-level field, and every existing JSON file would need to evolve (or accept empty defaults) just to remain coherent. The unified-array shape moves extension into the registry, where it belongs.

## Consequences

- One word, one rule. The JSON data-model reference describes the discriminator pattern once and references it everywhere.
- Order within a unified array is meaningful and stable. Authors who care about the order of two ops on the same Upgrade can express it directly.
- The Loader's referential-integrity pass and the per-`kind` validator dispatch are uniform across every depth of the JSON tree.
