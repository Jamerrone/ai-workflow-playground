# Player Actions API

## Synchronous application

Player Actions validate against current state and apply immediately. The transcript records `(currentTickIndex, action)`; on replay, the action is dispatched at the same tick index against the same state, producing byte-identical outcomes. There is no "queued for next tick" semantics — actions happen *between* ticks (the caller controls both action submission and tick driving), so no mid-tick race exists.

Multiple actions submitted between ticks process in submission order, each seeing the effect of the previous.

## Dual surface: methods + dispatch

The engine exposes one canonical entry point — `engine.dispatch(action)` — and ergonomic method shortcuts that delegate to it:

```ts
engine.placeTower("archer", { x: 3, y: 5 });
// equivalent to:
engine.dispatch({ kind: "placeTower", tower: "archer", position: { x: 3, y: 5 } });
```

Methods exist for the built-in action set (placeTower, sellTower, purchaseUpgrade, moveRallyPoint, overrideTargeting, sendNextWave). Plugins extend the action set by registering new `kind` values; their actions are only callable through `dispatch` unless the plugin author chooses to expose their own helper. Transcript replay always uses `dispatch`.

## Routing: the PlayerActionHandler registry

Every action `kind` is handled by exactly one entry in the **PlayerActionHandler** registry — the 12th entry in the fixed registry catalogue (CONTEXT.md). Built-in plugins are not privileged: the `towers` Plugin registers the `placeTower` / `sellTower` / `overrideTargeting` handlers through the same `api.registerActionHandler({ kind, handle })` surface a developer Plugin uses for a custom action. The `waves` Plugin registers `sendNextWave`; the `upgrades` Plugin registers `purchaseUpgrade`; the `guards` Plugin (a developer-Plugin worked example, per ADR-0011) registers `moveRallyPoint`.

Handler signature:

```ts
type ActionHandler<A extends PlayerAction, E = unknown> =
  (ctx: ActionContext, action: A) => ActionResult<E>;

interface ActionContext {
  readonly world: World;            // mutable; phase enforcement is off between ticks
  readonly registry: ConfigRegistry;
  readonly scenarioId: string;       // non-null — the kernel rejects dispatch when no scenario is loaded
  emit(event: GameEvent): void;
}
```

The kernel's `dispatch` does five things and nothing else: `assertAlive` → reject if no scenario loaded (`NO_SCENARIO_LOADED`) → look up handler by `action.kind` → reject if unregistered (`UNKNOWN_ACTION_KIND`) → call the handler and return its `ActionResult`. The kernel ships no handlers of its own.

Handlers structure as **validate → mutate → emit → return**. Validation must complete before any World mutation so a mid-handler failure cannot leave partial state. The handler emits any resulting GameEvents synchronously (see ADR-0016 for event-timing semantics around actions).

Handlers MAY delegate position / eligibility validation to other registry entries — the canonical case is `placeTower` delegating to the Map's PlacementMode entry. This keeps the towers Plugin independent of how many PlacementModes exist; a new PlacementMode (e.g. `free` with blocked regions) lands as a new registry entry without touching the towers Plugin.

## Rejected alternatives

## Result objects, not exceptions

Every action returns a typed result. Failures (insufficient gold, invalid position, etc.) are normal game outcomes, not exceptional control flow:

```ts
type ActionResult<T = ActionEffect> =
  | { ok: true;  effect: T }
  | { ok: false; code: ActionFailureCode; message: string; hint?: string };
```

Stable `code` values are part of the engine's public API (`"INSUFFICIENT_GOLD"`, `"INVALID_POSITION"`, `"UPGRADE_LOCKED_BY_EXCLUSIVE_GROUP"`, …). The success `effect` carries enough information for the UI to respond — the new entity's id, the new gold balance — without re-querying state.

## Rejected alternatives

- **Queued application.** Tidier in theory, but counter-intuitive UX ("why did my tower not appear?"). The phase-boundary cleanliness that Systems need doesn't apply to actions, which are not Systems.
- **Throwing on failure.** Forces every caller into try/catch for normal game outcomes; mirrors error-handling style we rejected at the Loader.
- **Action + GameEvent-only result.** Decouples call from outcome, forcing UI to subscribe and correlate. The `ActionResult` return is one less round-trip and reads better in callsite code.
