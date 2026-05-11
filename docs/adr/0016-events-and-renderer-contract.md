# GameEvents and Renderer contract

## Event subscription: typed per-kind + raw stream

The engine exposes both surfaces:

```ts
engine.on("towerFired", (event) => /* event payload typed to TowerFiredEvent */);
engine.onEvent((event) => /* every event, consumer dispatches on kind */);
```

`on(kind, handler)` is sugar around `onEvent` — one canonical delivery path, two ergonomic surfaces. Plugin-registered event kinds extend the typed `on` overloads via the same TypeScript declaration-merging pattern used for all plugin extensions.

## Event payload shape

Events are plain objects with a `kind` discriminator. Every event carries `tick` (the tick index it fired in). Firing events (`towerFired`, `guardFired`, plugin-emitted shoot events) carry the **source position** and each primary target's **position frozen at fire time** — renderers animate projectiles from those positions without re-querying state, which is essential because targets may have moved or died by the time the animation plays.

The full built-in event set: `towerPlaced`, `towerSold`, `towerFired`, `guardFired`, `enemySpawned`, `enemyDamaged`, `enemyKilled`, `enemyReachedBase`, `guardSpawned`, `guardDamaged`, `guardKilled`, `upgradePurchased`, `waveStarted`, `waveCleared`, `goldChanged`, `baseDamaged`, `scenarioWon`, `scenarioLost`.

## Delivery: end-of-tick batch, deterministic order

All events produced during a tick are delivered together at end-of-tick — never as side effects of individual System code. Within the batch, ordering is fixed: by phase produced (Wave → Simulation → Effect → Reward → Rule), then by System id within phase, then by production order within a System. Subscribers may rely on this order.

End-of-tick batching forecloses a class of determinism bugs (subscribers mutating state mid-tick via Actions) and makes "everything that happened this tick" a single logical step for renderers, UI, and test harnesses.

## State access for renderers

The primary read surface is a query API over the ECS world:

```ts
engine.world.query({
  all:  ["position", "tower"],
  any:  ["archerComponent", ...],   // optional
  none: ["sold"]                    // optional
});
```

Returns a typed iterator over matching entities. Iteration is over the kernel's dense component stores — cheap, no full-state scan. Renderers in the per-frame loop call `query` and render.

A `engine.snapshot()` utility returns a fully-serialisable plain object — entities keyed by id, each carrying its component map, frozen on the consumer side. Used for:

- Cross-thread serialisation (engine in a Worker, renderer on main).
- Determinism assertion (`assertSnapshotsEqual(node, browser)` after replaying the same transcript).
- Test fixtures.

The query API is the canonical surface for rendering; the snapshot utility is for serialisation / testing.

## Animation timing model

The engine is a fixed-step simulator with **tick-granular event timing**. There is no intra-tick time concept — production order within a phase is preserved but lost to consumers at delivery. Renderers handle two distinct timing concerns separately:

- **Smooth movement** is achieved by interpolating between the last two ticks' entity positions in render-time. Standard fixed-step renderer practice; the engine does not participate.
- **Event-driven animations** (projectile flight, hit flashes, death animations) may begin up to one tick after the simulated event. At typical tick rates (30–60 Hz) this is below human perception threshold and is not noticeable in play.

Precise sub-tick timing (a `tickFraction` field on events) is *not* added now. The cost — additional determinism surface, canonicalisation overhead, every System declaring intra-phase time — is not justified by the imperceptible gain. If a future feature like high-fidelity slow-motion replay needs it, it gets added then.

## Multi-renderer

Any number of renderers may subscribe and query simultaneously. The engine doesn't track or limit them. Renderers do not coordinate through the engine — two renderers consuming the same Scenario produce two independent renderings.

## Rejected alternatives

- **Immediate event delivery (side-effect inside System code).** Determinism risk and renderer hostility; no offsetting benefit.
- **Snapshot as the primary surface.** Heavy — clones every entity every tick when most renderers want a thin slice; works fine as a serialisation utility but wrong as the per-frame API.
- **Intra-tick timing on events (`tickFraction`).** Adds substantial determinism and API surface for sub-perception precision gain at typical tick rates.
