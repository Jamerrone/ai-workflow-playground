# AttackSelectionStrategy registry; `damage` removed from Attack `stats`

A multi-Attack attacker (Tower, Guard, hostile Enemy) re-evaluates which of its Attacks fires every tick. That selection is now a plugin-extensible **AttackSelectionStrategy**, parallel in shape to **TargetingStrategy** — a registered, `kind`-discriminated entry the kernel dispatches by `kind`. Built-ins:

- `declaration-order` (default) — the first eligible Attack in the author-declared array wins. Author-controlled ordering; deterministic and trivial.
- `highest-damage` — for each eligible Attack, sum every effect's `damagePreview(stats, fireContext)` and pick the largest. Re-evaluated every tick.

`TowerArchetypeConfig.attackSelection` is optional and accepts either an object (`{ "kind": "highest-damage" }`) or the string-shorthand from ADR-0015 (`"declaration-order"`). When absent, the engine substitutes `{ "kind": "declaration-order" }`.

## `damage` removed from Attack `stats`

Previously the combat-firing System sorted an attacker's Attacks by a hand-authored `stats.damage` field and fired the top one. That field had two problems: it was uncoupled from the Attack's actual effects (an author could write `damage: 100` on an Attack whose only effect was a `slow`), and it duplicated information that the AttackEffect already owns (`damage.amount`, `splash.amount`, `dot.damagePerTick`, …). Removed entirely. No registry, type, or test fixture may set `damage` inside an Attack's `stats` block.

Real expected damage is now computed by AttackEffects via an optional `damagePreview(stats, fireContext) => number` on `AttackEffectDef`. The built-in damage-bearing effects implement it with semantically accurate expressions:

| Effect       | `damagePreview`                                                 |
|--------------|------------------------------------------------------------------|
| `damage`     | `amount`                                                         |
| `splash`     | `amount × (enemies in radius at fire time)`                      |
| `pierce`     | `amount × (actual targets reachable, capped by maxTargets)`      |
| `line-pierce`| `amount × (actual targets reachable, capped by maxTargets)`      |
| `bounce`     | `amount × (1 + reachable hops, capped by hops)`                  |
| `dot`        | `damagePerTick × ceil(duration / interval)`                      |

Effects that deal no damage (`slow`, `target-count`, `projectile-count`, `minimum-range`, `heal`) omit `damagePreview`; the `highest-damage` strategy contributes 0 from them. Plugins that ship new damage-bearing effects opt in by exporting `damagePreview` on their `AttackEffectDef`.

## Loader warning

A Tower configured with `attackSelection: { "kind": "highest-damage" }` mounting an Attack whose effect kind lacks `damagePreview` produces a `DAMAGE_PREVIEW_MISSING` Loader warning (per ADR-0013 / the existing `REGISTRY_REPLACEMENT` pattern). The warning identifies the Tower, the Attack, and the offending effect kind. The Loader's built-in set covers every shipped damage-bearing effect; downstream callers extend it via the `damagePreviewKinds` LoaderOption when their plugins register additional preview-capable effects.

## Rejected alternatives

- **`selectionWeight` on effects.** Push the ranking onto each effect via `selectionWeight: 100`. Forces every plugin author to think about ranking even when their effect is irrelevant to it; produces silent mis-ranking when two plugins ship effects with overlapping weight bands; and offers no escape hatch for the genuinely common cases (round-robin, longest-range) that don't reduce to a per-effect scalar. Rejected.
- **Hardcoded-only rule (no registry).** Keep the "highest-damage" loop in the combat plugin and never extend it. Forecloses Round-Robin towers, Lowest-Cooldown Towers, anti-air precedence, weighted-random faction quirks, and every other selection mechanic that real TD games use. Inconsistent with the no-privileged-built-ins doctrine — every other cross-cutting decision in the engine is plugin-extensible. Rejected.
- **Declaration-order-only with no damage-aware built-in.** Forces every author who wants damage-aware selection to ship a plugin for it. The "pick the biggest hit" rule is the most common TD selection rule by far; shipping it built-in pays for itself.
- **Reusing TargetingStrategy.** Conflates two distinct concerns: which target an attacker prefers among eligible targets, vs which Attack an attacker prefers among its own off-cooldown weapons. Both are decisions; both happen every tick; the right vocabulary keeps them separate.

## Consequences

- `combat/fire` no longer reads `attack.stats.damage` anywhere; the field is gone.
- `TargetingStrategy` and `AttackSelectionStrategy` are sibling concepts in CONTEXT.md and the Plugin authoring guide (Slice 21).
- Upgrades that previously wrote `field: "damage"` against an Attack's stats block are rewritten to target the relevant effect's `amount` field via `effectId`. The semantics are now real damage deltas, not hand-typed numbers.
- The registries catalogue grows by one: **AttackSelectionStrategy** joins **TargetingStrategy** alongside the existing ten public registries.
