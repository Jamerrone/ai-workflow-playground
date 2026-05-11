import { describe, it, expect } from "vitest";
import { createEngine } from "../src/index.js";
import type { GameEvent } from "../src/index.js";
import { builtInBundle } from "../src/plugins/builtin/index.js";
import { buildTracerRegistry } from "./helpers/tracer-registry.js";

describe("end-to-end tracer", () => {
  function runTracer(seed: number): {
    snapshot: string;
    events: GameEvent[];
    won: boolean;
    lost: boolean;
  } {
    const engine = createEngine(buildTracerRegistry(), {
      plugins: builtInBundle,
      seed,
    });
    const events: GameEvent[] = [];
    let won = false;
    let lost = false;
    engine.onEvent((e) => events.push(e));
    engine.on("scenarioWon", () => {
      won = true;
    });
    engine.on("scenarioLost", () => {
      lost = true;
    });

    engine.loadScenario("tracer");
    const placed = engine.placeTower("archer", { x: 2, y: 0 });
    expect(placed.ok).toBe(true);
    const sent = engine.sendNextWave();
    expect(sent.ok).toBe(true);

    let safety = 0;
    while (!won && !lost && safety++ < 200) engine.tick(0.1);

    const snapshot = engine.snapshot();
    engine.dispose();
    return { snapshot, events, won, lost };
  }

  it("plays a minimum scenario to a win condition", () => {
    const { events, won, lost } = runTracer(12345);
    expect(won).toBe(true);
    expect(lost).toBe(false);
    expect(events.map((e) => e.kind)).toContain("enemyKilled");
  });

  it("produces byte-identical snapshot across two independent runs with the same seed", () => {
    const a = runTracer(12345);
    const b = runTracer(12345);
    expect(a.snapshot).toBe(b.snapshot);
  });
});
