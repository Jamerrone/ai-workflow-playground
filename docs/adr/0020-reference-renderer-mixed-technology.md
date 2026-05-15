# Reference Renderer: mixed-technology layers — Canvas 2D gameplay, DOM HUD, stub audio

The browser reference demo (Slice 17) ships three independent Renderer instances built on deliberately different technologies. ADR-0016 already establishes that a Renderer is an event-subscription + world-query contract, not a particular technology — this ADR commits the reference demo to making that claim *visible* by mixing techs across layers, and pins which tech each layer uses.

## The split

- **`GameplayRenderer` — Canvas 2D, per-frame redraw with interpolation.** Subscribes to firing/lifecycle events for projectile animations. Reads world state via `engine.world.query` on every `requestAnimationFrame`. Maintains its own prev/curr position maps (snapshotted by the loop calling `beforeTick()` / `afterTick()` around each `engine.tick`) and interpolates between them using the loop's accumulator factor.
- **`HudRenderer` — DOM elements, event-driven updates.** Subscribes only via `engine.on(kind, …)` for `goldChanged`, `waveStarted`, `waveCleared`, `baseDamaged`, `scenarioWon`, `scenarioLost`. No per-frame loop; updates only when a relevant event fires. Renders gold, current wave, base HP, and the win/loss banner as ordinary HTML.
- **`AudioRenderer` — stub.** Subscribes to fire/kill events and `console.log`s the sound it *would* play. No commitment to a real audio backend in this slice.

## Why mix techs rather than pick one

Canvas 2D is the right tool for dozens-to-hundreds of moving entities with per-frame interpolation: a single redraw call per frame, no DOM thrash, easy to reason about. It is the wrong tool for text and accessible controls — font metrics and layout are a meaningful headache in Canvas, and assistive tech can't see canvas content.

DOM is the right tool for a HUD: text rendering, accessibility, and event-driven updates that don't need a per-frame loop. The browser already maintains it. The cost — DOM mutations being slower than Canvas pixel pushes — doesn't matter for a HUD that only changes a handful of fields per tick.

A monolithic all-Canvas renderer would either reinvent DOM-style text layout or punt on accessibility. A monolithic all-DOM renderer would thrash on per-frame entity updates. Splitting along the natural seam — per-frame visual world versus event-driven status overlay — lets each layer pick the tool that fits, and demonstrates that the same engine contract supports both styles simultaneously.

## Why a stub audio renderer

Audio is genuinely a "renderer" in the ADR-0016 sense (subscribes to events, never coordinates through the engine), and shipping a stub one makes that explicit in the reference demo. A real Web Audio / Howler backend brings its own decisions (asset format, mixing, latency, cross-environment timing) that would inflate this slice without serving its goal — proving the engine ports to the browser. The stub is one class with one `console.log` per event kind; swapping it for a real backend later changes nothing about the engine, the loop, or the other renderers.

## Consequences

- **Future renderer additions follow the same pattern**: pick a tech per concern, subscribe through the public API, never coordinate through the engine. Minimap, replay scrubber, debug overlay — each a separate Renderer class, each free to pick its own tech.
- **Tests for renderer logic stay per-class.** GameplayRenderer's interpolation tests run against Canvas 2D primitives; HudRenderer's tests assert on the resulting DOM. No shared mock surface.
- **Slice 18's cross-environment determinism is unaffected.** Renderers are read-only against engine state (ADR-0016); mixed tech adds no determinism surface.

## Rejected alternatives

- **All-Canvas with stacked `<canvas>` layers.** A gameplay-canvas and a ui-overlay-canvas, each with its own Canvas2D context, positioned with CSS. Loses accessibility, makes text rendering painful, gains no measurable performance — the HUD redraws rarely enough that DOM cost is invisible.
- **Single canvas with z-ordered draws.** Background → entities → projectiles → UI all drawn into one context in one function. Simplest to write, but hides the "renderers are independent" architectural story the reference demo exists to make explicit. Pedagogically the worst option.
- **All-DOM (no Canvas).** Entities as absolutely-positioned DOM nodes updated every frame. Hundreds of nodes mutating per frame is exactly what DOM is bad at. Hard 'no' for projectile-heavy scenes.
- **Web Audio / Howler in this slice.** Asset pipeline, mixing, cross-environment latency tuning — all real decisions, all orthogonal to "does the engine port to the browser". Deferred until a slice exists whose goal is audio.
