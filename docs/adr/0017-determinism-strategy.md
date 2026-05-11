# Determinism strategy: IEEE 754 with discipline, seeded Mulberry32 PRNG, canonical iteration

The engine guarantees that the same `ConfigRegistry`, the same seed, and the same input transcript produce byte-identical state at every tick, across every JavaScript environment (Node, browser, web worker, test harness). This ADR pins how that guarantee is implemented.

## Floating-point: IEEE 754, transcendentals forbidden

Positions are sub-tile floats. Stat math uses standard IEEE 754 arithmetic. The basic operations — `+`, `-`, `*`, `/`, `Math.sqrt`, `Math.abs`, `Math.floor`/`ceil`/`round`/`trunc` — are spec-deterministic across every modern JavaScript engine and may be used freely in tick code.

**Transcendentals are forbidden in tick code:** `Math.sin`, `Math.cos`, `Math.tan`, `Math.asin`/`acos`/`atan`/`atan2`, `Math.exp`, `Math.log`, `Math.pow` with non-integer exponents. These differ between V8 and JSC and have no standardised result. Dev-mode enforcement: the kernel installs a Proxy on `Math` during plugin tick code execution that throws on these methods; production builds skip the check. A linter rule (an ESLint plugin) catches them statically.

Fixed-point arithmetic was rejected because the cognitive cost to every plugin author (scale tracking, overflow, integer division semantics) is high, the forbidden-operation set is narrow and easily checkable, and the cross-environment determinism test in CI catches any drift loudly.

## Randomness: seeded Mulberry32 with per-System sub-streams

Every randomness source in tick code goes through the kernel-provided PRNG. `Math.random()` is forbidden (dev-mode trap, same Proxy mechanism). The algorithm is **Mulberry32**: 32-bit state, ~10 lines of code, statistical quality more than adequate for game randomness, period 2^32 sufficient for a game session.

Per-System sub-streams isolate randomness. The kernel's master PRNG is seeded from the supplied seed; each registered System receives its own sub-PRNG, deterministically spawned from the master via SplitMix32 keyed on the System's id. Two Systems sharing one stream would have their outputs depend on each other's execution order; sub-streams decouple them, so adding or removing a System doesn't shift the random sequence of unrelated Systems.

API: a System's `run` function receives a `rng` capability with methods `rng.next() -> number in [0,1)`, `rng.int(min, max) -> integer in [min, max]`, `rng.pick(array) -> element`. All deterministic, all sub-stream-isolated.

## Iteration order and snapshot canonicalisation

- **Entity ids** are allocated as a monotonic 1-based counter for the lifetime of the engine instance. Order is allocation order.
- **Component stores** iterate in entity-id ascending order. The kernel owns the stores; plugins cannot influence iteration order.
- **Plugin / System / Registry collections** iterate in declared order (topological for plugin dependencies; stable-id for tie-breaks in System order — per ADR-0002).
- **`Map` and `Set` are forbidden as Component values.** Plugins may use them as locals within a tick but must not store them on entities. The Loader / Component validator rejects schemas typed as `Map`/`Set`. (Plain objects, arrays, primitives only.)
- **Snapshot serialisation** is canonical: object keys sorted alphabetically; numbers serialised with a stable formatter that avoids `Number.prototype.toString` edge cases (notably negative zero, sub-normals, very-large numbers). The snapshot's byte form is reproducible across environments.

## Cross-environment validation

The Node demo and the Browser demo each run a determinism-validation pass: load the shared Scenario, replay a recorded input transcript, assert byte-identical snapshots against a reference recording. CI runs the Browser pass in a headless harness. Any drift between environments fails the build with the first divergent tick highlighted.
