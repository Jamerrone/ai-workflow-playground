# Wave and Scenario JSON shape

## Wave shape

A Wave is a standalone, path-agnostic JSON object that lists its WaveGroups. Each WaveGroup specifies enemy kind, count, spawn `interval` (seconds between spawns), and optional `delay` (seconds from wave start). Bosses are WaveGroups with `count: 1`.

```json
{
  "id": "wave-1", "kind": "wave",
  "duration": 30,
  "groups": [
    { "id": "front-grunts", "enemy": "grunt", "count": 10, "interval": 0.5, "delay": 0 },
    { "id": "back-bats",    "enemy": "bat",   "count": 5,  "interval": 1.0, "delay": 8 }
  ],
  "meta": { "name": "Opening Push" }
}
```

Chosen `interval` + `delay` over an "over N seconds" duration form because the latter degenerates when `count: 1` (over what?), and over explicit timing patterns because the verbose form earns its place only for power-user cases. An optional `pattern` array can be added later as a sibling to `interval`; the engine prefers `pattern` when both are present.

## Scenario shape

A Scenario references Waves and a Map by id, carries per-wave path bindings co-located with each wave reference, and nests starting-state under `gameRuleOverrides`:

```json
{
  "id": "tutorial", "kind": "scenario",
  "map": "forest",
  "defaultPath": "main",
  "waves": [
    "wave-1",
    { "wave": "wave-2", "paths": { "elite-bats": "aerial" } },
    { "wave": "wave-3", "paths": { "g1": "main", "g2": "aerial", "g3": "secondary" } },
    { "wave": "wave-4", "paths": { "*": "aerial" } }
  ],
  "waveTrigger": { "kind": "hybrid" },
  "gameRuleOverrides": {
    "globalBaseHealth": { "mode": "global", "value": 20 },
    "startingGold": 100
  },
  "difficulty": null,
  "meta": { "name": "Tutorial" }
}
```

### Path-binding forms

A Scenario's `waves` list accepts three forms per entry, picked by what's most natural for the case:

- **String id** (`"wave-1"`): all groups on the Scenario's `defaultPath`. The 80% case.
- **Object with wildcard** (`{ "wave": "...", "paths": { "*": "aerial" } }`): all groups on a single non-default path.
- **Object with per-group bindings** (`{ "wave": "...", "paths": { "g1": "main", "g2": "aerial" } }`): mixed distribution. Used when groups within one Wave genuinely span multiple Paths.

Bindings live next to the wave reference rather than in a separate top-level `pathBindings` array, so debugging "why is this enemy going the wrong way" reads top-to-bottom in one place.

### Loader integrity for Scenarios

- Every WaveGroup id referenced in `paths` must exist on the referenced Wave.
- Every WaveGroup in every referenced Wave must end up bound (via `*`, an explicit entry, or `defaultPath`).
- Every Path id used must exist on the Scenario's Map.
- Every Enemy referenced by a WaveGroup must have a movement kind compatible with its bound Path.

## Composition rules

- **Waves, Difficulties, and Maps are referenced by id only**, never inlined into a Scenario. Reuse is the whole point of separate Wave files; inlining would defeat it and complicate referential integrity.
- **Starting state lives under `gameRuleOverrides`**, keyed by GameRule id. Built-in rules (`globalBaseHealth`, `startingGold`, `enemyEngagementCap`, …) and plugin-registered rules contribute to the same block — no top-level Scenario fields change when plugins add rules.
