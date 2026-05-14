# Loader error reporting

## Collect-all, never fail-fast

The Loader runs every per-entry validator against every entry, skipping invalid entries from the registry it returns. Referential-integrity checks run against the *validated* subset; entries that failed validation don't produce duplicate downstream errors. The Loader returns:

```ts
type LoaderResult =
  | { ok: true;  registry: ConfigRegistry; warnings: LoaderError[] }
  | { ok: false; errors:   LoaderError[];   warnings: LoaderError[] };
```

A 20-tower data set with five typos is fixed in one Loader run, not five. The cost is some Loader complexity (skip-and-continue rather than throw); it pays for itself on the first multi-error session.

## Structured error objects

```ts
type LoaderError = {
  severity: "error" | "warning";
  code: string;          // stable machine-readable, e.g. "UNIT_SUFFIX_FORBIDDEN"
  path: string;          // dotted, e.g. "towers.archer.attacks[0].stats.cooldownMs"
  source?: { file: string; line?: number; col?: number };
  message: string;       // human-readable
  expected?: string;
  actual?: string;
  hint?: string;
};
```

Stable `code` values are part of the engine's public API. A default formatter renders the structure into the human-readable form below. Tooling (IDE plugins, CI groupers, autofixers) consumes the structure directly.

```
ERROR  UNIT_SUFFIX_FORBIDDEN   data/towers/archer.json:12
  towers.archer.attacks[0].stats.cooldownMs
  Field name 'cooldownMs' uses a forbidden unit suffix.
  expected: number (seconds), field named 'cooldown'
  actual:   2000 (named 'cooldownMs')
  hint:     all engine durations are in seconds — 2000 ms = 2.0 seconds.
```

## Warnings vs. errors

Errors block the load. Warnings do not. Policy:

- **Error**: malformed JSON, unrecognised `kind`, missing required field, type mismatch, forbidden unit suffix, broken reference, inheritance cycle, tag mismatch on a Path binding, cross-kind inheritance, reference to an `abstract: true` definition.
- **Warning**: unused definition (defined but never referenced), tag used in a `targetFilter` that no Enemy in the registry carries, suspicious-but-legal value (e.g. offensive Tower with `range: 0`).

A `strict: true` option on the load call promotes all warnings to errors — recommended for CI, off in the dev loop.

## Source positions and environment-agnosticism

The engine package consumes an already-assembled in-memory `ConfigRegistry`. The canonical load path is environment-agnostic: same object, same engine call, in Node / browser / web worker / test harness.

A separate `loadFromDirectory` utility (Node-only) walks the filesystem, reads raw JSON, builds the registry, and captures source positions populated into `LoaderError.source`. Browser users either static-import their JSON and assemble the registry programmatically, or `fetch` it at runtime and do the same. Browser-side `LoaderError.source` is `undefined` unless the consumer supplies their own source map.

## Plugin-extensible bucket validators

Per-bucket JSON validation is plugin-contributed, not hardcoded in the Loader. Every built-in bucket (Maps, Towers, Enemies, Waves, Scenarios, Upgrades) ships its validator on the same `RegistrationApi.registerBucketValidator(def)` a third-party plugin would call to add a new bucket — `heroes`, `portals`, anything. The Loader's per-entry pass dispatches through `LoaderOptions.bucketValidators`, a `ReadonlyMap<bucket, BucketValidatorDef>` populated by running plugins through `collectBucketValidators(plugins)`.

```ts
api.registerBucketValidator({
  bucket: "heroes",
  validate(ctx) {
    if (typeof ctx.entry.power !== "number") {
      ctx.addError({
        severity: "error",
        code: "INVALID_FIELD",
        path: `${ctx.path}.power`,
        message: `Hero '${ctx.id}' is missing 'power'.`,
      });
    }
  },
});
```

`BucketValidatorContext` carries the entry being validated plus the full `input` (for cross-bucket reference checks), the active `LoaderOptions`, the `abstractIds` map, and `addError`/`addWarning` accumulators. Validators never throw — they push structured errors and let the Loader run the rest of the input, preserving the collect-all contract.

The default `buildRegistry` exported from `src/index.ts` injects the built-in plugin bundle's validators when no `bucketValidators` is supplied, so JSON-only callers don't need to wire anything. Callers that ship their own plugin set call `collectBucketValidators(myPlugins)` and pass the result through `LoaderOptions`.

## Rejected alternatives

- **Throw on first error.** Defensible for programmatic consumers; hostile to JSON-only authors.
- **String-only errors.** Saves a couple of fields and forecloses every kind of tooling. The default formatter renders structured errors into the same strings anyway.
- **Errors-only, no warnings.** Forces every soft hint to be either silent or fatal. Real authoring needs the middle category.
- **Hardcoded `switch` over bucket names in `validate.ts`.** The original Loader dispatched validation through a `switch (bucket) { case "maps": ... }`. It worked, but it singled out a single category of plugin contribution (bucket validators) for special treatment, making built-in buckets unforkable and custom buckets impossible without editing the Loader. Replaced by the plugin-contributed registry above.
