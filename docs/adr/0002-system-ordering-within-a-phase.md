# System ordering within a tick phase

Inside a single tick phase, systems run in a topological order derived from explicit `before` / `after` declarations on each registered system, with ties broken by stable system id (a fully-qualified string like `barracks/rallyPointSpawn`). Cycles fail at engine construction. The kernel surfaces the resolved order at construction so plugin authors can verify their system slots in where they expected.

Chosen over ordering by plugin load order (brittle — any change to the plugin dependency graph could silently flip system order and break determinism) and over auto-ordering by component-access stratification (elegant for "writer before reader" but cannot express ordering between systems that touch disjoint component sets, e.g. wave spawning before movement). Explicit `before` / `after` is what every mature ECS converged on for the same reasons.

Kernel-internal systems (effect resolution, event flush, etc.) are registered with stable public ids and are addressable from plugin `before` / `after` declarations. They are not a privileged tier hidden from plugins — keeping them addressable preserves the "no privileged built-ins" doctrine that defines this engine.

## Consequences

- Tie-break is by system id, not by registration order. Registration order is a function of plugin load order, which is itself derived from a topo sort with degrees of freedom; id-based tie-break is invariant under those.
- Every system must carry a fully-qualified id (`pluginId/systemName`). The id is part of the plugin's public surface — renaming a system is a breaking change for any plugin that ordered against it.
