import { describe, it, expect, vi } from "vitest";
import { createEngine } from "../src/index.js";
import { builtInBundle } from "../src/plugins/builtin/index.js";
import { buildTracerRegistry } from "./helpers/tracer-registry.js";
import { TranscriptActionSource } from "../demos/browser/action-source.js";
import { BrowserDemoLoop, MaxSpeedClock } from "../demos/browser/loop.js";

const FIXED_DT = 0.1;

function makeEngine() {
  return createEngine(buildTracerRegistry(), { plugins: builtInBundle, seed: 1 });
}

function makeNullRenderer() {
  return {
    beforeTick: vi.fn(),
    afterTick: vi.fn(),
    draw: vi.fn(),
  };
}

describe("TranscriptActionSource", () => {
  it("returns empty array for ticks with no actions", () => {
    const src = new TranscriptActionSource({ actions: [] });
    expect(src.actionsForTick(0)).toHaveLength(0);
    expect(src.actionsForTick(99)).toHaveLength(0);
  });

  it("returns actions for the correct tick", () => {
    const action = { kind: "sendNextWave" } as const;
    const src = new TranscriptActionSource({ actions: [[5, action]] });
    expect(src.actionsForTick(4)).toHaveLength(0);
    expect(src.actionsForTick(5)).toHaveLength(1);
    expect(src.actionsForTick(5)[0]).toBe(action);
    expect(src.actionsForTick(6)).toHaveLength(0);
  });

  it("groups multiple actions at the same tick", () => {
    const a1 = { kind: "sendNextWave" } as const;
    const a2 = { kind: "sendNextWave" } as const;
    const src = new TranscriptActionSource({ actions: [[3, a1], [3, a2]] });
    expect(src.actionsForTick(3)).toHaveLength(2);
  });
});

describe("MaxSpeedClock", () => {
  it("calls step repeatedly until stop is called", () => {
    const clock = new MaxSpeedClock(FIXED_DT);
    let calls = 0;
    clock.start((dt) => {
      expect(dt).toBe(FIXED_DT);
      calls++;
      if (calls >= 5) clock.stop();
    });
    expect(calls).toBe(5);
  });
});

describe("BrowserDemoLoop", () => {
  it("runs through a scenario and produces snapshots", () => {
    const engine = makeEngine();
    const renderer = makeNullRenderer();
    const clock = new MaxSpeedClock(FIXED_DT);
    const loop = new BrowserDemoLoop({
      engine,
      scenarioId: "tracer",
      actionSource: new TranscriptActionSource({ actions: [] }),
      clock,
      fixedDt: FIXED_DT,
      maxTicks: 50,
      gameplayRenderer: renderer,
    });

    loop.start();

    expect(loop.snapshots.length).toBeGreaterThan(0);
    expect(loop.snapshots.length).toBeLessThanOrEqual(50);
    expect(renderer.beforeTick).toHaveBeenCalled();
    expect(renderer.afterTick).toHaveBeenCalled();
    expect(renderer.draw).toHaveBeenCalled();
    engine.dispose();
  });

  it("stops at maxTicks even if scenario not resolved", () => {
    const engine = makeEngine();
    const clock = new MaxSpeedClock(FIXED_DT);
    const loop = new BrowserDemoLoop({
      engine,
      scenarioId: "tracer",
      actionSource: new TranscriptActionSource({ actions: [] }),
      clock,
      fixedDt: FIXED_DT,
      maxTicks: 10,
      gameplayRenderer: makeNullRenderer(),
    });

    loop.start();
    expect(loop.snapshots).toHaveLength(10);
    engine.dispose();
  });

  it("sends actions from the action source at the right ticks", () => {
    const engine = makeEngine();
    const dispatchSpy = vi.spyOn(engine, "dispatch");
    const clock = new MaxSpeedClock(FIXED_DT);
    const action = { kind: "sendNextWave" } as const;
    const loop = new BrowserDemoLoop({
      engine,
      scenarioId: "tracer",
      actionSource: new TranscriptActionSource({ actions: [[2, action]] }),
      clock,
      fixedDt: FIXED_DT,
      maxTicks: 5,
      gameplayRenderer: makeNullRenderer(),
    });

    loop.start();
    expect(dispatchSpy).toHaveBeenCalledWith(action);
    engine.dispose();
  });
});
