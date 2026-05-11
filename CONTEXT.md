# Tower Defense Engine

A plugin-first Tower Defense engine: a small kernel that owns the tick loop, the state container, and a fixed set of named registries — and a catalogue of plugins (built-in and developer-supplied) that contribute every gameplay feature through those registries.

## Language

### Lifecycle

**Engine construction**:
A one-time setup. `createEngine(registry, { plugins, seed })` loads plugins, populates registries, validates the ConfigRegistry. No Scenario is active until `loadScenario` is called.
_Avoid_: bootstrap, init

**loadScenario**:
Engine action that resets all Scenario-introduced state (entities, gold, wave index, base health, tick counter, transcript) and re-initialises from a Scenario in the same ConfigRegistry. The ConfigRegistry, loaded plugins, master PRNG seed, and event subscribers survive. Calling it mid-Scenario implicitly ends the previous one.
_Avoid_: restart, reset, new game

**saveState / loadState**:
Engine actions that capture and restore mid-Scenario state. Two formats: `snapshot` (direct restore, default — works even if game-data changed since save) and `transcript` (replays the input transcript from the saved tick — smaller, requires the determinism guarantee, used for bug reports and the cross-environment test).
_Avoid_: serialise, persist, dump

**dispose**:
Engine action that detaches every event subscriber and marks the engine unusable. Subsequent method calls throw `EngineDisposedError`. Explicit only — no automatic dispose.
_Avoid_: destroy, cleanup, teardown

### Guarantees

**Determinism**:
The same ConfigRegistry, the same seed, and the same input transcript produce byte-identical state at every tick across every environment. Plugins use the kernel-supplied seeded PRNG; transcendental math (`sin`, `cos`, `exp`, …) is forbidden in tick code; iteration order is entity-id ascending; snapshot serialisation is canonical.
_Avoid_: reproducibility, replayability

### Architecture

**Kernel**:
The minimal core of the engine. Owns the tick driver, the state container, the registries, and the event bus. Ships no gameplay of its own.
_Avoid_: core, runtime, framework

**Plugin**:
A unit of extension. Registers entries into one or more registries. Built-in plugins and developer plugins share one capability surface — there are no privileged built-ins.
_Avoid_: module, extension, mod

**Registry**:
A named, kernel-owned collection that plugins register entries into. The fixed catalogue of registries is the engine's only public extension surface. The catalogue: **Component**, **EntityKind**, **System**, **AttackEffect**, **TargetingStrategy**, **UpgradeOp**, **PlacementMode**, **MapFeature**, **WaveTrigger**, **RewardKind**, **GameRule**. Plugin-extensible event kinds are *not* a registry — they extend the GameEvent type via TS declaration merging.
_Avoid_: registrar, factory, container

### State

**Entity**:
An in-world game object identified by a stable id. Carries no state of its own — its state lives in the **Component**s attached to it.
_Avoid_: unit, object, instance, thing

**Component**:
A registered, named, typed unit of entity state (e.g. `position`, `health`, `rallyPoint`). Plugins extend the shape of entities by registering new Components; archetypes (**EntityKind**) compose them.
_Avoid_: trait, mixin, aspect, field-bag

**EntityKind**:
An archetype prototype — a named bundle of Components plus a JSON `kind` discriminator. The engine ships Tower, Enemy, Guard, and Projectile as built-in EntityKinds; plugins may register more (e.g. Hero).
_Avoid_: class, type, blueprint, prefab

**System**:
A registered piece of per-tick logic. Belongs to exactly one **Phase** and carries a fully-qualified id (`pluginId/systemName`) and optional `before`/`after` declarations. Systems read and write Components directly; the kernel enforces phase boundaries.
_Avoid_: Behavior, behavior tree, AI script, update hook

### Entities

**Tower**:
A stationary built archetype placed on the Map by the player, subject to the Map's PlacementMode. Carries a `cost`, one or more Attacks (or none, for pure-summoner Towers), an UpgradeTree, and a `strategy` (TargetingStrategy). May carry a `summon` Component to spawn **Guard**s.
_Avoid_: defense, building, turret

**Enemy**:
An archetype that travels along a Path toward a Base. Carries `tags` (which double as Path-compatibility and Attack-target labels), `stats` (`hp`, `speed`, `baseDamage`), an optional `attacks` array (used against Guards), and a `killReward`.
_Avoid_: mob, creep, monster

**Summon**:
A mortal archetype spawned by another entity. Guards are Summons. Resurfaces after a configurable cooldown when killed; the cooldown is per-summoner, not per-Summon.
_Avoid_: minion, pet, familiar

**Guard**:
A Summon deployed by a Barracks-style Tower. Spawns at the parent Tower and walks to the current Rally Point. Engages Enemies within the union-of-Attack-range. Inherits the parent Tower's purchased `guardModifier` upgrades live — buying an upgrade buffs every existing Guard immediately. Passively regenerates while not engaged; fully heals on Wave completion.
_Avoid_: unit, soldier, minion

**Rally Point**:
A player-mutable runtime position on the parent Tower (a Component, not a separate entity) where Guards deploy. Must be within `summon.rallyPointRange` tiles of the Tower and on a tile a Tower could be placed on *or* a Path tile. Bases, BlockedRegions, and tower-occupied tiles are forbidden. Off-path placement is a strategic choice, not an engine error.
_Avoid_: spawn point, guard position, waypoint

**EntityTag**:
A string label on an entity. Tags carry two responsibilities: (1) Path compatibility — an Enemy bound to a Path must include the Path's `kind` as a tag (Loader-enforced); (2) Attack targeting — every Attack's `targetFilter` matches against tags (runtime). Plugin-registered tags work the same as built-in ones.
_Avoid_: unit type, enemy type, category

### Combat

**Attack**:
A discrete offensive action belonging to an entity. Carries an `id`, a **TargetFilter**, a `stats` block (the engine-interpreted numeric properties — damage, range, cooldown), and zero or more **AttackEffect**s.
_Avoid_: weapon, ability, skill

**AttackEffect**:
A registered modifier on an Attack (`dot`, `slow`, `splash`, `pierce`, `bounce`, …). Multiple effects compose on a single Attack; multiple effects of the same kind may coexist, each with its own local `id`. Effect stats live on the effect, not on the parent Attack.
_Avoid_: attack type, attack mode, attack mechanic

**TargetFilter**:
An eligibility constraint on an Attack, expressed as a `require` / `exclude` pair of tag sets matched against a candidate target's tags. Symmetric — applies to Tower→Enemy, Guard→Enemy, and Enemy→Guard alike.
_Avoid_: targeting rules, hit conditions

**TargetingStrategy**:
The strategy by which an attacker chooses among eligible targets. Built-in: `closest-to-base`, `lowest-hp`, `highest-hp`, `tag-priority`. Re-evaluated every tick. Overridable by the player per Tower at runtime.
_Avoid_: targeting mode, attack priority

**Engagement**:
The mutual targeting relationship between a Guard and an Enemy. An Enemy stops to engage only if it has an Attack whose `targetFilter` accepts the Guard; a Guard fires on any in-range Enemy its `targetFilter` accepts, whether or not the Enemy stopped. Unarmed Guards are "walls" — they absorb damage and die without retaliation.
_Avoid_: combat lock, fight, lock-on

### Upgrades

**UpgradeTree**:
A flat list of **Upgrade** nodes attached to an EntityKind (commonly a Tower). The DAG is implicit in each node's `prerequisites`. `tier` is a UI-ordering hint only — the engine assigns no mechanical meaning to it.
_Avoid_: skill tree, talent tree

**Upgrade**:
A node in an UpgradeTree. Carries an ordered `ops` array of UpgradeOps, optional `cost`, optional `prerequisites` (other Upgrade ids), and an optional `exclusiveGroup` label.
_Avoid_: level, enhancement, power-up

**UpgradeOp**:
A registered kind of upgrade operation, dispatched by `kind`. Built-in: `stat` (delta on a single stat, optionally scoped by `effectId`), `attackMutation` (`add` / `modify` / `removeEffect` / `addEffect`), `guardModifier` (delta on a Guard-spawn stat).
_Avoid_: upgrade action, upgrade change

**ExclusiveGroup**:
An optional string label on an Upgrade. Upgrades sharing the same label are mutually exclusive — purchasing one prevents purchasing any other in the group.
_Avoid_: tier lock, upgrade path

### World

**Map**:
A layout — `width`, `height` in tiles, one or more **Path**s, one or more **Base**s, optional **BlockedRegion**s and **TowerSlot**s, a **PlacementMode**. Structural and gameplay-relevant; renderer-side decoration lives in `meta`.
_Avoid_: level, stage, board

**Path**:
An ordered sequence of `{x, y}` waypoints from a spawn (the first waypoint) to a **Base** (the last waypoint). Carries a `kind` (`ground` or `aerial` built-in, plugin kinds allowed). Consecutive waypoints differ on exactly one axis — no diagonals.
_Avoid_: route, lane, track

**Base**:
A defendable endpoint of one or more Paths, identified by `id` and `position`. Carries health (pool mode and starting health are GameRule overrides on the Scenario). Any Base reaching 0 health ends the Scenario as a loss.
_Avoid_: castle, endpoint, goal

**BlockedRegion**:
A rectangular `{x, y, width, height, kind}` area on a Map where Tower placement is forbidden. The `kind` is a renderer hint — the engine treats every BlockedRegion identically.
_Avoid_: obstacle tile, terrain tile

**MapFeature**:
A plugin-registered kind of feature a Map may carry beyond Paths and Bases. Built-in: `blocked-region`. Plugins may register additional kinds (spawn portals, healing wells, terrain modifiers). Uses the standard `kind`-discriminator pattern.
_Avoid_: terrain, decoration

**TowerSlot**:
A pre-declared `{x, y}` tile on a Map designated for Tower placement, used when the Map's PlacementMode is `fixed`.
_Avoid_: build spot, placement marker

**PlacementMode**:
A plugin-registered rule set governing where Towers may be placed. Built-in: `{ "kind": "fixed" }` and `{ "kind": "free" }`. Plugin-registered modes carry their own configuration fields alongside `kind`.
_Avoid_: build mode, placement type

### Sessions

**Wave**:
A standalone, path-agnostic set of **WaveGroup**s. Reusable across Scenarios. Carries an optional `duration` cap; when present and the timer expires, the next Wave force-starts and survivors persist.
_Avoid_: round, spawn group, level

**WaveGroup**:
A group of Enemies within a Wave, sent together. Carries an `id`, an `enemy` reference, a `count`, an `interval` (seconds between spawns), and an optional `delay` (seconds from Wave start). Bosses are WaveGroups with `count: 1`.
_Avoid_: enemy group, spawn batch, swarm

**WaveTrigger**:
A `kind`-discriminated config for how Waves advance. Built-in: `{ "kind": "manual" }` (player advances), `{ "kind": "auto" }` (timer-driven), `{ "kind": "hybrid" }` (timer-driven with player override). If a Wave omits `duration`, only `manual` is valid.
_Avoid_: wave mode, advance mode

**Scenario**:
The playable assembly — references a Map and a list of Waves by id, co-locates per-wave path bindings, configures the WaveTrigger, overrides starting GameRules, and optionally references a Difficulty. Default win condition: all Waves cleared without any Base reaching 0 health. Default loss condition: any Base reaching 0 health. Custom GameRules may layer additional conditions.
_Avoid_: level, mission, run

**Difficulty**:
An optional named modifier set referenced by a Scenario. Carries enemy stat multipliers, kill reward multiplier, wave-clear reward multiplier. A Scenario can be played without one.
_Avoid_: game mode, challenge tier

**GameRule**:
A registered global rule the engine evaluates. Built-in: `enemyEngagementCap`, `defaultSellRefundPercent`, `globalBaseHealth`, `startingGold`. Scenarios override per-rule under `gameRuleOverrides`; plugin-registered rules use the same block.
_Avoid_: setting, parameter, config

**RewardKind**:
A registered way the player earns or loses resources. Built-in: `gold-on-kill` (awards `killReward` when an Enemy dies), `sell-value` (returns `(towerCost + purchasedUpgradeCosts) × refundPercent` when a Tower is sold), `wave-clear` (awards a Wave's clear bonus when finished before duration expires). Plugins register additional kinds (xp, custom drops, mana regen).
_Avoid_: drop, loot, reward type

### Data

**ConfigRegistry**:
A fully-hydrated, in-memory collection of all game-object definitions passed to the engine at construction. The engine performs no I/O — it only consumes a ConfigRegistry. Same object shape across all environments (Node, browser, web worker, test harness).
_Avoid_: game config, data store, definitions

**Loader**:
A utility (separate from the engine) that takes raw game-data — either a directory path (Node helper `loadFromDirectory`) or a programmatic input — and produces either a `ConfigRegistry` plus warnings, or a list of structured errors and warnings. Resolves TemplateInheritance, validates by `kind` via plugin-registered validators, runs referential-integrity checks. Errors are collect-all (never fail-fast) and machine-readable.
_Avoid_: parser, importer, deserialiser

### Composition

**Template**:
A named, reusable definition of any kind. Other definitions inherit from one or more Templates. Flagged with `abstract: true` if it must not be referenced directly (only inherited from); concrete definitions may serve both roles.
_Avoid_: base class, archetype, parent

**TemplateInheritance**:
The resolution process — parents in declared order are merged first, later parents overwrite earlier ones, the child overwrites all parents. Nested objects deep-merge; arrays of keyed discriminator objects (those with unique `id` or unique `kind` per item) merge by key; other arrays replace entirely. Inheritance is restricted to matching `kind`. Deletion is not expressible.
_Avoid_: extends, mixin, prototype chain

### Authoring

**Meta**:
A universal, optional, free-form object on every config type (Tower, Attack, Upgrade, Enemy, Wave, Scenario, …). Carries renderer-facing display data — name, description, icon path, translation key, flavor text. The engine never reads, validates, or echoes this field.
_Avoid_: display, label, tooltip data, presentation

**Canonical units**:
All JSON quantities use a single canonical unit. Time in seconds, distance in tiles, ratios in 0–1, multipliers in 0–N, counts as non-negative integers. Field names carry no unit suffix — `cooldown`, never `cooldownMs`; `range`, never `rangeTiles`.
_Avoid_: SI units, normalised units

**String shorthand**:
Any field whose canonical form is a discriminator-object accepts a plain string when the kind has no other configuration. `"strategy": "closest-to-base"` is equivalent to `"strategy": { "kind": "closest-to-base" }`. The Loader normalises strings to objects before validation; plugin validators only see object form.
_Avoid_: enum value, plain string config

### Tick

**Tick**:
A single discrete simulation step. Duration in seconds is supplied by the caller; the engine has no internal scheduling. The atomic time unit — there is no intra-tick time.
_Avoid_: frame, update, step

**GameEvent**:
A typed signal emitted by the engine after state changes within a tick. Every GameEvent carries `tick`. Firing events (Tower fired, Guard fired) include source and target positions frozen at fire time. Events for a tick are delivered together at end-of-tick in deterministic order (phase → System id → production order).
_Avoid_: update event, state change, notification

**Renderer**:
Any consumer of GameEvents and the world query API. The engine ships no renderer of its own; multiple renderers may subscribe simultaneously and do not coordinate through the engine. Smooth movement is the renderer's responsibility (interpolate between ticks); event-driven animations may begin up to one tick after the simulated event (sub-perception at typical tick rates).
_Avoid_: display, view, output

**Phase**:
One of the ordered stages of a tick. The fixed phases are **Wave**, **Simulation**, **Effect**, **Reward**, **Rule**, **Emit**. Every System belongs to exactly one Phase.
_Avoid_: stage, pass

## Relationships

- A **Kernel** owns many **Registries**; each **Registry** holds entries contributed by **Plugin**s.
- An **Entity** has many **Component**s; an **EntityKind** declares the default Component bundle for entities of that kind.
- A **System** runs in exactly one **Phase**; within a Phase, Systems are ordered by `before`/`after` then by stable id.
- A **Plugin** may register: Components, EntityKinds, Systems, and entries in any other registry it has reason to extend.

## Example dialogue

> **Dev:** "If I want every **Tower** to track a charge meter, do I fork the Tower **EntityKind**?"
> **Domain expert:** "No — register a `charge` **Component**, register a **System** that runs in the **Simulation phase** and ticks the charge, and register a `requires: [charge]` attachment on the Tower **EntityKind**. The built-in Tower stays unchanged."

> **Dev:** "Can I make my custom targeting **System** run before the built-in Movement system?"
> **Domain expert:** "Yes — register it in the **Simulation phase** with `before: ['kernel/movement']`. The kernel will surface the resolved order at construction so you can verify."
