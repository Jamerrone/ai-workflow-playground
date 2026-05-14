import { describe, it, expect } from "vitest";
import { createEngine } from "../src/index.js";
import type { ConfigRegistry, GameEvent } from "../src/index.js";
import { builtInBundle } from "../src/plugins/builtin/index.js";

/**
 * Builds a registry with three back-to-back single-enemy waves. Each Wave has a
 * short `duration` so the wave force-clears at the first tick after activation —
 * this lets a test exercise wave-clear → cooldown → wave-start cycles without
 * having to model combat.
 */
function buildTriggerRegistry(waveTrigger: { kind: string; cooldown?: number }): ConfigRegistry {
  return {
    components: {},
    entityKinds: {},
    maps: {
      m: {
        width: 20,
        height: 1,
        paths: [
          {
            id: "p1",
            kind: "ground",
            waypoints: [
              { x: 0, y: 0 },
              { x: 19, y: 0 },
            ],
          },
        ],
        bases: [{ id: "b1", position: { x: 19, y: 0 } }],
        towerSlots: [{ x: 2, y: 0 }],
        placementMode: { kind: "fixed" },
      },
    },
    towers: {},
    enemies: {
      grunt: {
        tags: ["ground"],
        stats: { hp: 1, speed: 0.0001, baseDamage: 0 },
        killReward: 0,
      },
    },
    summons: {},
    waves: {
      w1: {
        groups: [{ id: "g1", enemy: "grunt", count: 1, interval: 0, delay: 0 }],
        duration: 0.001,
      },
      w2: {
        groups: [{ id: "g1", enemy: "grunt", count: 1, interval: 0, delay: 0 }],
        duration: 0.001,
      },
      w3: {
        groups: [{ id: "g1", enemy: "grunt", count: 1, interval: 0, delay: 0 }],
        duration: 0.001,
      },
    },
    scenarios: {
      s: {
        map: "m",
        waves: [
          { id: "w1", pathBindings: { g1: "p1" } },
          { id: "w2", pathBindings: { g1: "p1" } },
          { id: "w3", pathBindings: { g1: "p1" } },
        ],
        waveTrigger,
        gameRuleOverrides: {
          globalBaseHealth: 10_000_000,
          startingGold: 0,
        },
      },
    },
    upgrades: {},
    difficulties: {},
    gameRules: {},
  };
}

describe("Slice 9: auto wave-trigger", () => {
  it("auto advancement: Wave N+1 starts cooldown/dt ticks after Wave N clears", () => {
    const engine = createEngine(buildTriggerRegistry({ kind: "auto", cooldown: 1.0 }), {
      plugins: builtInBundle,
      seed: 1,
    });
    const started: GameEvent[] = [];
    const cleared: GameEvent[] = [];
    engine.on("waveStarted", (e) => started.push(e));
    engine.on("waveCleared", (e) => cleared.push(e));
    engine.loadScenario("s");
    // Run plenty of ticks so all three waves cycle through.
    for (let i = 0; i < 60; i++) engine.tick(0.1);
    engine.dispose();

    // Three waves should have started and cleared.
    expect(started.map((e) => e.waveIndex)).toEqual([0, 1, 2]);
    expect(cleared.map((e) => e.waveIndex)).toEqual([0, 1, 2]);

    // Gap between successive starts equals cooldown / dt = 10 ticks (because
    // each wave force-clears on the same tick it starts via duration=0.001).
    const startTicks = started.map((e) => e.tick as number);
    expect(startTicks[1]! - startTicks[0]!).toBe(10);
    expect(startTicks[2]! - startTicks[1]!).toBe(10);

    // Wave 1 starts exactly cooldown/dt ticks after wave 0 clears.
    const cleared0 = cleared[0]!.tick as number;
    const started1 = started[1]!.tick as number;
    expect(started1 - cleared0).toBe(10);
  });

  it("auto rejects sendNextWave with AUTO_TRIGGER_NOT_INTERACTIVE", () => {
    const engine = createEngine(buildTriggerRegistry({ kind: "auto", cooldown: 1.0 }), {
      plugins: builtInBundle,
      seed: 2,
    });
    engine.loadScenario("s");
    const result = engine.sendNextWave();
    engine.dispose();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("AUTO_TRIGGER_NOT_INTERACTIVE");
  });

  it("waveStarted event under auto carries trigger=auto", () => {
    const engine = createEngine(buildTriggerRegistry({ kind: "auto", cooldown: 1.0 }), {
      plugins: builtInBundle,
      seed: 3,
    });
    const started: GameEvent[] = [];
    engine.on("waveStarted", (e) => started.push(e));
    engine.loadScenario("s");
    for (let i = 0; i < 15; i++) engine.tick(0.1);
    engine.dispose();
    expect(started.length).toBeGreaterThanOrEqual(1);
    const first = started[0]!;
    expect(first.kind).toBe("waveStarted");
    expect(typeof first.tick).toBe("number");
    expect(first.waveIndex).toBe(0);
    expect(first.trigger).toBe("auto");
  });
});

describe("Slice 9: hybrid wave-trigger", () => {
  it("hybrid early-start: sendNextWave mid-cooldown immediately starts the wave", () => {
    const engine = createEngine(buildTriggerRegistry({ kind: "hybrid", cooldown: 5.0 }), {
      plugins: builtInBundle,
      seed: 4,
    });
    const started: GameEvent[] = [];
    engine.on("waveStarted", (e) => started.push(e));
    engine.loadScenario("s");
    // Tick a little (cooldown = 5.0, dt = 0.1 → 50 ticks until natural start).
    for (let i = 0; i < 3; i++) engine.tick(0.1);
    expect(started.length).toBe(0);
    // Force-start before the natural cooldown elapses.
    const r = engine.sendNextWave();
    expect(r.ok).toBe(true);
    // The waveStarted event fires synchronously inside dispatch.
    expect(started.length).toBe(1);
    expect(started[0]!.waveIndex).toBe(0);
    expect(started[0]!.trigger).toBe("hybrid");
    engine.dispose();
  });

  it("hybrid duration-expiry: with no sendNextWave, the trigger advances at the cooldown boundary", () => {
    const engine = createEngine(buildTriggerRegistry({ kind: "hybrid", cooldown: 1.0 }), {
      plugins: builtInBundle,
      seed: 5,
    });
    const started: GameEvent[] = [];
    const cleared: GameEvent[] = [];
    engine.on("waveStarted", (e) => started.push(e));
    engine.on("waveCleared", (e) => cleared.push(e));
    engine.loadScenario("s");
    // Don't call sendNextWave. Run enough ticks for two waves.
    for (let i = 0; i < 30; i++) engine.tick(0.1);
    engine.dispose();
    expect(started.map((e) => e.waveIndex)).toContain(0);
    expect(started.map((e) => e.waveIndex)).toContain(1);
    const cleared0 = cleared.find((e) => e.waveIndex === 0)!.tick as number;
    const started1 = started.find((e) => e.waveIndex === 1)!.tick as number;
    expect(started1 - cleared0).toBe(10);
  });
});

describe("Slice 9: manual wave-trigger (regression)", () => {
  it("manual still requires sendNextWave; no auto-advancement", () => {
    const engine = createEngine(buildTriggerRegistry({ kind: "manual" }), {
      plugins: builtInBundle,
      seed: 6,
    });
    const started: GameEvent[] = [];
    engine.on("waveStarted", (e) => started.push(e));
    engine.loadScenario("s");
    for (let i = 0; i < 100; i++) engine.tick(0.1);
    expect(started.length).toBe(0); // never auto-started
    engine.sendNextWave();
    expect(started.length).toBe(1);
    expect(started[0]!.trigger).toBe("manual");
    engine.dispose();
  });
});
