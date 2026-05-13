# Tags, engagement, and attack selection

## Tags carry both Path compatibility and Attack filtering

A single tag set on each entity does double duty. A Path declares its `kind` (`"ground"`, `"aerial"`, or any plugin-registered kind); an Enemy must carry a tag matching the Path's `kind` for the Loader to accept a WaveGroup → Path binding. At runtime, every Attack's `targetFilter: { require, exclude }` matches against the same tags. There is no separate `movementKind` field on Enemies — it would be redundant.

Plugins that register new Path kinds advertise the tag Enemies must carry. Plugins that register new descriptive tags (`armored`, `undead`, `boss`) work the same way for targeting. The vocabulary is uniform.

## Engagement is a three-point rule

1. **Engagement is mutual targeting.** A Guard targets an Enemy; an Enemy may target a Guard. The `enemyEngagementCap` GameRule limits how many Enemies may simultaneously target one Guard.

2. **The Enemy decides whether to stop.** An Enemy stops to engage a Guard only if it has at least one Attack whose `targetFilter` accepts the Guard. Otherwise the Enemy walks past, taking incidental damage from any in-range Guard whose own `targetFilter` accepts it.

3. **The Guard fires on its own filter.** A Guard attacks any in-range Enemy that matches the Guard's `targetFilter`, whether or not the Enemy stopped. Unarmed Guards function as "walls" — they absorb damage, occupy engagement slots, and die without retaliating.

Aerial Paths are not a special case. The standard rule produces every expected behavior: a flying Enemy with no anti-Guard Attack walks past (rule 2 fails); a flying Enemy whose Attack accepts Guards engages them (rule 2 succeeds); an anti-air Guard fires at passing flying Enemies whether or not they stop (rule 3 always applies).

An entity's engagement range is the union of its Attacks' `range` stats — no separate `engagementRadius` config. A unit with a melee Attack (range 1) and a ranged Attack (range 4) engages within 4 tiles, fires the ranged Attack at distance, switches to melee when in close.

## Attack selection: one per tick, via AttackSelectionStrategy

Each tick, every attacker picks one of its off-cooldown Attacks whose `targetFilter` accepts an in-range target. Exactly one Attack fires per tick per attacker. The choice among eligible Attacks is the **AttackSelectionStrategy** registry (see [ADR-0019](0019-attack-selection-strategy.md)); built-in strategies are `declaration-order` (default) and `highest-damage`.

Per-Attack cooldowns are the spam-control mechanism. The engine enforces no global cooldown; a plugin can layer entity-level cooldown if a specific game needs it.

## Rejected alternatives

- **A separate `movementKind` field on Enemies.** Redundant once tags carry the same information. Removed.
- **An "aerial Paths bypass Guards regardless" special case.** Forecloses hostile-aerial-escort gameplay; the standard engagement rule produces the same default behavior with strictly more expressive power.
- **An engine-level global cooldown.** Per-Attack cooldowns plus one-per-tick selection are sufficient; plugins can layer more if a game demands it.
- **Healing via negative-damage Attacks.** Breaks event semantics (`enemyDamaged` with `damage: -10` is incoherent for renderers and analytics), conflates with damage-modifying plugins, and has weird edge cases (healing a 0-hp entity). Use a registered `heal` AttackEffect instead.
- **A hardcoded `damage`-stat-sort attack-selection rule.** Originally the combat plugin sorted Attacks by an Attack-level `stats.damage` field. That field was uncoupled from the Attack's effects (authors could lie) and forbade pluggable selection rules. Replaced by the AttackSelectionStrategy registry; see [ADR-0019](0019-attack-selection-strategy.md).
