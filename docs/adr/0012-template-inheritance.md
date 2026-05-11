# TemplateInheritance: merge-by-id for keyed arrays, replace otherwise

Templates compose by inheritance. A child config lists one or more parent Template ids in order; the Loader resolves the chain by deep-merging objects and merging-or-replacing arrays per the rules below. The child's own fields always overwrite resolved parent values.

## Merge rules

- **Nested objects deep-merge.** `stats: { hp: 100, speed: 2 }` in a parent and `stats: { hp: 150 }` in a child resolve to `stats: { hp: 150, speed: 2 }`.
- **Discriminator-keyed arrays merge by key.** Arrays of objects where every item carries a unique `id` (Attacks, Upgrades, Paths, Bases, WaveGroups, …) merge item-by-item: a child item with id `arrow` patches the parent's `arrow`; child items not present in the parent are appended. The same applies to arrays where every item's `kind` is unique within the array.
- **All other arrays replace entirely.** Arrays of scalars, arrays where items lack a stable key, and arrays where keys collide all replace the parent's array. The Loader detects which rule applies per-array; authors do not annotate.
- **Deletion is not expressible.** A child cannot remove a parent's keyed item — if you need a Tower without one of the parent's Attacks, you choose a different parent or duplicate the JSON. The complexity cost of supporting deletion (magic flags, sigil syntax, or array-rebuild semantics) outweighs the rare need.

## Template visibility

A definition opts into "abstract" status with `"abstract": true`. Abstract definitions exist only to be inherited from; the Loader rejects any Scenario reference that resolves to an abstract definition (`waves: ["template-base"]` fails if `template-base` is abstract). Concrete definitions default to `abstract: false` and may be both used directly and inherited from.

## Kind compatibility

A definition may only inherit from Templates of the same `kind`. The Loader rejects cross-kind inheritance (a `kind: "tower"` definition cannot extend a `kind: "enemy"` Template). This catches typos at registration time rather than producing surprising runtime behavior.

## Resolution order

Parents are listed as an ordered array. Earlier parents are merged first; later parents overwrite where fields conflict. The child overwrites all resolved parents. Cycles in the inheritance graph fail at construction with all participants named.

## Rejected alternatives

- **Pure array replace everywhere.** Forces authors to restate a whole `attacks` list to tweak one field — defeats the point of inheritance for the common case.
- **Explicit merge operators** (`"attacks+": [...]`, magic `$delete` flags, `kind: "patch"` overlay nodes). Each adds a vocabulary an author must learn; the merge-by-key default expresses 95% of intents naturally.
- **Allowing partial-array deletion via magic flags.** Saves a tiny amount of typing in rare cases at the cost of adding a sigil-syntax to JSON. Authors who need deletion duplicate the JSON instead.
