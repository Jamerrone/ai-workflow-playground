import { describe, it, expect } from "vitest";
import { createEngine } from "../src/index.js";
import type { GameEvent, Plugin } from "../src/index.js";
import { emptyRegistry } from "./helpers/empty-registry.js";
import { buildTracerRegistry } from "./helpers/tracer-registry.js";
import { builtInBundle } from "../src/plugins/builtin/index.js";

describe("PlayerActionHandler seam", () => {
  it("returns UNKNOWN_ACTION_KIND for a dispatched action with no registered handler", () => {
    // Scenario must be loaded for the kernel to reach the handler-lookup step.
    const minimalScenarioPlugin: Plugin = {
      id: "test/minimal-scenario",
      register(api) {
        api.onScenarioLoad(() => {});
      },
    };
    const reg = {
      ...emptyRegistry(),
      scenarios: { tiny: { map: "m1" } },
      maps: { m1: { width: 1, height: 1, bases: [], paths: [], placementMode: { kind: "fixed" } } },
    };
    const engine = createEngine(reg, { plugins: [minimalScenarioPlugin], seed: 0 });
    engine.loadScenario("tiny");
    const result = engine.dispatch({ kind: "noSuchAction" });
    engine.dispose();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("UNKNOWN_ACTION_KIND");
  });

  it("returns NO_SCENARIO_LOADED before reaching the handler lookup", () => {
    const engine = createEngine(emptyRegistry(), { plugins: [], seed: 0 });
    // No scenario loaded — dispatch should fail before checking for a handler.
    const result = engine.dispatch({ kind: "placeTower" });
    engine.dispose();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("NO_SCENARIO_LOADED");
  });

  it("a developer Plugin can register a new action kind that's callable through engine.dispatch", () => {
    const myActionEffects: Array<{ value: number }> = [];
    const customPlugin: Plugin = {
      id: "test/custom-action",
      register(api) {
        api.onScenarioLoad(() => {});
        api.registerActionHandler({
          kind: "customDouble",
          handle(_ctx, action) {
            const v = (action as unknown as { value: number }).value;
            return { ok: true, effect: { doubled: v * 2 } };
          },
        });
      },
    };
    const reg = {
      ...emptyRegistry(),
      scenarios: { tiny: { map: "m1" } },
      maps: { m1: { width: 1, height: 1, bases: [], paths: [], placementMode: { kind: "fixed" } } },
    };
    const engine = createEngine(reg, { plugins: [customPlugin], seed: 0 });
    engine.loadScenario("tiny");
    const result = engine.dispatch({ kind: "customDouble", value: 21 } as unknown as Parameters<typeof engine.dispatch>[0]);
    engine.dispose();
    expect(result.ok).toBe(true);
    if (result.ok) expect((result.effect as { doubled: number }).doubled).toBe(42);
    void myActionEffects;
  });

  it("action-produced events fire synchronously inside dispatch — before it returns", () => {
    const events: GameEvent[] = [];
    const engine = createEngine(buildTracerRegistry(), { plugins: builtInBundle, seed: 0 });
    engine.onEvent((e) => events.push(e));
    engine.loadScenario("tracer");
    const eventsBeforePlace = events.length;
    const result = engine.placeTower("archer", { x: 2, y: 0 });
    const eventsRightAfterPlace = events.length;
    engine.dispose();
    expect(result.ok).toBe(true);
    // towerPlaced + goldChanged should have fired during dispatch, not at end-of-tick.
    expect(eventsRightAfterPlace - eventsBeforePlace).toBeGreaterThanOrEqual(2);
    const placed = events.find((e) => e.kind === "towerPlaced");
    expect(placed).toBeDefined();
    expect(placed!.archetype).toBe("archer");
  });

  it("placeTower delegates to the Map's PlacementMode entry for position validation", () => {
    // Register a custom PlacementMode that only accepts (9, 9). Use it on a new map.
    const restrictivePlugin: Plugin = {
      id: "test/restrictive-mode",
      register(api) {
        api.registerPlacementMode({
          kind: "single-tile",
          validate(position) {
            return position.x === 9 && position.y === 9
              ? { ok: true }
              : { ok: false, reason: `only (9,9) is allowed, got (${position.x},${position.y})` };
          },
        });
      },
    };
    const reg = buildTracerRegistry();
    // Swap the tracer map's placement mode to the custom one.
    (reg.maps as any)["tracer-map"].placementMode = { kind: "single-tile" };
    // Add (9,9) as a position that's NOT a fixed-mode tower slot (since we're using single-tile).
    // The PlacementMode entry alone decides validity; fixed-mode towerSlots are ignored.
    const engine = createEngine(reg, {
      plugins: [restrictivePlugin, ...builtInBundle],
      seed: 0,
    });
    engine.loadScenario("tracer");
    const wrong = engine.placeTower("archer", { x: 2, y: 0 });
    const right = engine.placeTower("archer", { x: 9, y: 9 });
    engine.dispose();
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.code).toBe("INVALID_POSITION");
    expect(right.ok).toBe(true);
  });

  it("a subscriber can dispatch another action in response to a synchronous action event", () => {
    const calls: string[] = [];
    const engine = createEngine(buildTracerRegistry(), { plugins: builtInBundle, seed: 0 });
    engine.loadScenario("tracer");
    engine.on("towerPlaced", () => {
      calls.push("subscriber-saw-towerPlaced");
      // Submit a follow-up action. It's between-tick, so it must succeed (or fail with a real code).
      const r = engine.sendNextWave();
      calls.push(r.ok ? "sendNextWave-ok" : `sendNextWave-${r.code}`);
    });
    const placed = engine.placeTower("archer", { x: 2, y: 0 });
    engine.dispose();
    expect(placed.ok).toBe(true);
    expect(calls).toEqual(["subscriber-saw-towerPlaced", "sendNextWave-ok"]);
  });
});
