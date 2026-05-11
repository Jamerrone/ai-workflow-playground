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
