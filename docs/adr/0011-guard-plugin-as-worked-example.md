# Guard plugin: built-in, and the worked example for cross-cutting plugin patterns

The Guard / Barracks system ships as a built-in plugin and doubles as the canonical worked example in the plugin authoring guide. It deliberately exercises every cross-cutting plugin capability the engine offers — registering a new EntityKind (Guard), attaching Components to a built-in archetype (Tower), running Systems that spawn entities mid-tick, registering a custom GameRule (engagement cap), emitting custom GameEvents (`guardSpawned`, `guardFired`, `guardKilled`), and cross-entity parent→child state inheritance (Guard reflects Tower's purchased upgrades live).

## Components

A Tower opts into summoning by carrying a `summon` Component (config, loaded from JSON):

```json
"components": {
  "summon": {
    "summons": "guard-footman",
    "maxCount": 3,
    "respawnCooldown": 8,
    "rallyPointRange": 6
  }
}
```

A placed Tower also gains a `rallyPoint` Component at runtime, holding `{ x, y }` — initialised to the Tower's own position and mutated by the player's `moveRallyPoint` action. There is no JSON form for the `rallyPoint` Component; it is runtime-only. This is the first explicit example of the **config / runtime split** for Components: a Component may have a config schema (loaded from JSON), a runtime schema (Loader doesn't see), or both. `summon` is config-only; `rallyPoint` is runtime-only.

## Live attack inheritance

The Guard's Attacks live on the Guard's own EntityKind definition. The Tower's `guardModifier` UpgradeOps modify the Guard's resolved attack stats live: buying an upgrade with `{ kind: "guardModifier", attackId: "sword", stat: "damage", delta: 5 }` immediately raises the `damage` of every existing Footman spawned from that Tower. Selling the Tower despawns all its Guards.

## Rally Point placement

The destination of a `moveRallyPoint` action must satisfy:

- Within `summon.rallyPointRange` tiles of the parent Tower.
- A tile a Tower could be placed on (per the Map's PlacementMode), **OR** a Path tile. Bases, BlockedRegions, and tower-occupied tiles are always forbidden.

Off-path placement (e.g. between paths, in open ground) is a strategic choice, not an engine error.

## Respawn cadence

A Barracks respawns Guards one-at-a-time. The `respawnCooldown` is a *per-Tower* timer, not per-Guard. When any Guard dies the timer starts (or continues if already running); on expiry, exactly *one* Guard spawns at the Tower's position with full hp and walks toward the current Rally Point. If three Guards die simultaneously, they respawn at `t + respawnCooldown`, `t + 2·respawnCooldown`, `t + 3·respawnCooldown` — never in parallel.

## Healing and idle regen

A Guard not currently engaged regenerates `stats.idleRegen` hp per second up to its `stats.hp` max. On Wave completion, every surviving Guard heals to full instantly. Damaged Guards mid-engagement do not regen.

## The doctrine the worked example exists to demonstrate

Healing and summoning by other plugins follow the same pattern: register a new AttackEffect (`heal`, `summon`) with its own config schema and handler. The kernel exposes a mid-tick entity-spawn API the handler calls. Tags handle ally / enemy distinction by convention — the engine has no built-in "side" concept. A future "Cleric" enemy plugin and a future "Necromancer" enemy plugin both follow the same patterns the Guard plugin demonstrates; no engine changes required.
