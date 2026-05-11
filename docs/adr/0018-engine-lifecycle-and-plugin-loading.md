# Engine lifecycle and plugin loading

## Construction is one-time, scenarios are repeatable

```ts
const engine = createEngine(registry, {
  plugins: [...builtInBundle, myCritPlugin],
  seed: 12345
});
```

Construction loads plugins (topological sort by declared dependencies), populates the registries, and validates the ConfigRegistry against the now-registered validators. After construction, no Scenario is active — entities, gold, wave state, transcript do not exist yet.

## `loadScenario(scenarioId)` — what resets, what survives

**Resets every call:**
- All entities (Towers, Guards, Enemies, Projectiles) and all their Components.
- Gold, wave index, base health, transient game-rule state.
- The tick counter (back to 0).
- The input transcript (back to empty).
- Per-System PRNG sub-streams — re-spawned deterministically from the master seed.

**Survives:**
- The `ConfigRegistry` and all loaded plugins.
- The master PRNG seed (so sub-streams re-spawn identically across `loadScenario` calls within one engine instance).
- Registered event subscribers — renderers stay subscribed across Scenarios and receive a clean stream of events from the new Scenario.

Calling `loadScenario` while a Scenario is active implicitly ends the previous one. There is no separate `unloadScenario`.

## Save / load mid-Scenario: snapshot or transcript, caller picks

```ts
type SavedState =
  | { scenarioId: string; tickIndex: number; seed: number;
      format: "snapshot"; snapshot: WorldSnapshot }
  | { scenarioId: string; tickIndex: number; seed: number;
      format: "transcript"; transcript: Array<[tick: number, action: PlayerAction]> };

engine.saveState({ format: "snapshot" });   // default
engine.saveState({ format: "transcript" }); // smaller, requires determinism
engine.loadState(saved);
```

**Snapshot** is the default — fast load (direct restore), works even when game-data has shifted between save and load. Larger save file.

**Transcript** is the determinism gold standard — `loadState` runs `loadScenario(scenarioId)` then replays the transcript. Smaller save file. Critical for bug-report reproduction and the cross-environment determinism test.

Both supported because the underlying primitives (snapshot serialisation, transcript recording) already exist for other reasons.

## `engine.dispose()`

Detaches every event subscriber, clears internal state, marks the engine unusable. Any method call after `dispose` throws `EngineDisposedError`. There is no automatic dispose (no WeakRef, no finaliser) — the caller is explicit.

## Missing-plugin error: helpful hints via a known-kinds index

Plugins statically export the list of `kind` values they contribute, separate from their runtime registration (the same module that contains the plugin's TypeScript declaration-merging block also exports its kind list as a static array). The engine builds an index of "kinds known to plugins not currently loaded" at construction.

When the Loader hits an unrecognised `kind`, the `UNKNOWN_KIND` error includes a hint:

- If the kind belongs to a plugin in the user's import graph but not in their `plugins` array: `"'crit-plugin' is imported but not in your plugins array."`
- If the kind belongs to a known third-party plugin: `"'crit-tower' is registered by plugin 'crit-plugin' — is it loaded?"`
- Otherwise: `"no plugin known to register this kind."`

The infrastructure cost is small (one static array per plugin); the DX win is large.

## Plugin versioning is deliberately deferred

Game-data files do not declare expected plugin versions — no `requiresPlugin: { 'crit-plugin': '^1.0.0' }` in JSON. The per-kind validator dispatch catches schema drift automatically: old game-data fails validation against a new schema with the standard `INVALID_FIELD` error.

If a real versioning need emerges (a published plugin marketplace, complex migration scenarios), a versioning system can be designed against the actual constraints rather than imagined ones. Building it speculatively forecloses too many options.

## Plugin replacement audit

When a plugin explicitly replaces a previously-registered entry, the engine emits a `LoaderError` with `severity: "warning"` and `code: "REGISTRY_REPLACEMENT"`. Replacement is sometimes legitimate (a balance-mod intentionally replaces); the warning makes it observable without being fatal. Tests asserting "no unexpected replacements" filter the load result's warnings by code.

```
WARN  REGISTRY_REPLACEMENT  tower:archer
  Plugin 'fancy-archer-plugin' replaced 'tower:archer' previously registered by 'built-in-towers'.
```
