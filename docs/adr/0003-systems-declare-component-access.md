# Systems declare their Component reads and writes

Every System is registered with explicit `reads: [componentId, …]` and `writes: [componentId, …]` lists. The kernel hands the System mutable references only to its declared-writable Components and pre-filtered iterables over the entities it queried. Components also declare which Phase(s) may write them at registration time, so the kernel can refuse to register a System whose declared writes don't match its Phase.

Chosen over a free-form `run(world)` signature because declarations buy three things the free-form shape can't:

1. **Construction-time diagnostics.** "System X reads Component Y, but no loaded plugin provides Y" surfaces at engine construction, not deep inside a tick.
2. **Determinism guard.** "Two Systems in the same Phase both write Component Y" — a silent determinism breaker under free-form mutation — fails fast at construction.
3. **Cheap phase enforcement.** No per-access Proxy traps; phase boundaries are enforced structurally by what the kernel hands the System, plus a dev-mode freeze of un-declared Components.

Rejected parameter-typed injection (Bevy / Unity DOTS style) because the introspection it relies on is ergonomic in Rust and awkward in TypeScript — either experimental decorators or runtime tokens, both of which collapse back into the plain-object form with extra ceremony.

## Consequences

- The dev-mode enforcement promised in the ECS state model ADR shifts from per-access Proxy traps to structural narrowing plus a freeze of un-attached Components. Reads of a Component a System didn't declare throw in dev mode; in production the System simply doesn't receive a handle.
- Components carry a `writableIn: [phaseId, …]` declaration. This is part of the Component's contract; it doesn't change after registration.
