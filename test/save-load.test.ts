import { describe, it, expect } from "vitest";
import {
  createEngine,
  EngineDisposedError,
  type Engine,
} from "../src/index.js";
import { builtInBundle } from "../src/plugins/builtin/index.js";
import { buildTracerRegistry } from "./helpers/tracer-registry.js";
import { buildUpgradesRegistry } from "./helpers/upgrades-registry.js";

function makeTracerEngine(seed = 12345): Engine {
  return createEngine(buildTracerRegistry(), {
    plugins: builtInBundle,
    seed,
  });
}

function playTracerUntilEnemySpawned(engine: Engine): void {
  engine.loadScenario("tracer");
  const placed = engine.placeTower("archer", { x: 2, y: 0 });
  expect(placed.ok).toBe(true);
  const sent = engine.sendNextWave();
  expect(sent.ok).toBe(true);
  // Tick a few times — enough to spawn the enemy and accumulate state, but not finish.
  for (let i = 0; i < 5; i++) engine.tick(0.1);
}

describe("saveState / loadState — snapshot format", () => {
  it("returns a snapshot bundle carrying scenarioId, tickIndex, seed, and the serialised world", () => {
    const engine = makeTracerEngine();
    playTracerUntilEnemySpawned(engine);
    const bundle = engine.saveState({ format: "snapshot" });
    engine.dispose();
    expect(bundle.format).toBe("snapshot");
    expect(bundle.scenarioId).toBe("tracer");
    expect(bundle.tickIndex).toBe(5);
    expect(bundle.seed).toBe(12345);
    if (bundle.format === "snapshot") {
      expect(typeof bundle.world).toBe("string");
      // The serialised world is canonical JSON — parseable.
      const parsed = JSON.parse(bundle.world) as { tick: number };
      expect(parsed.tick).toBe(5);
    }
  });

  it("JSON-stringifies byte-identically for two engines reaching the same state", () => {
    const eA = makeTracerEngine();
    playTracerUntilEnemySpawned(eA);
    const bundleA = eA.saveState({ format: "snapshot" });
    eA.dispose();

    const eB = makeTracerEngine();
    playTracerUntilEnemySpawned(eB);
    const bundleB = eB.saveState({ format: "snapshot" });
    eB.dispose();

    expect(JSON.stringify(bundleA)).toBe(JSON.stringify(bundleB));
  });

  it("snapshot round-trip: loadState on a fresh engine reproduces the original engine's next-tick snapshot byte-for-byte", () => {
    const eOriginal = makeTracerEngine();
    playTracerUntilEnemySpawned(eOriginal);
    const bundle = eOriginal.saveState({ format: "snapshot" });
    eOriginal.tick(0.1);
    const nextSnap = eOriginal.snapshot();
    eOriginal.dispose();

    const eRestored = makeTracerEngine();
    eRestored.loadState(bundle);
    eRestored.tick(0.1);
    const restoredNextSnap = eRestored.snapshot();
    eRestored.dispose();

    expect(restoredNextSnap).toBe(nextSnap);
  });
});

describe("saveState / loadState — transcript format", () => {
  it("returns a transcript bundle carrying scenarioId, tickIndex, seed, ticks, and actions", () => {
    const engine = makeTracerEngine();
    playTracerUntilEnemySpawned(engine);
    const bundle = engine.saveState({ format: "transcript" });
    engine.dispose();
    expect(bundle.format).toBe("transcript");
    expect(bundle.scenarioId).toBe("tracer");
    expect(bundle.tickIndex).toBe(5);
    expect(bundle.seed).toBe(12345);
    if (bundle.format === "transcript") {
      expect(Array.isArray(bundle.ticks)).toBe(true);
      expect(bundle.ticks.length).toBe(5);
      expect(Array.isArray(bundle.actions)).toBe(true);
      // Two actions were dispatched: placeTower and sendNextWave, both at tickIndex 0.
      expect(bundle.actions.length).toBe(2);
      expect(bundle.actions[0]![0]).toBe(0);
      expect(bundle.actions[0]![1].kind).toBe("placeTower");
      expect(bundle.actions[1]![1].kind).toBe("sendNextWave");
    }
  });

  it("transcript bundle is smaller than the snapshot bundle for the same state", () => {
    const engine = makeTracerEngine();
    playTracerUntilEnemySpawned(engine);
    const snap = engine.saveState({ format: "snapshot" });
    const trans = engine.saveState({ format: "transcript" });
    engine.dispose();
    expect(JSON.stringify(trans).length).toBeLessThan(JSON.stringify(snap).length);
  });

  it("transcript round-trip: loadState replays actions+ticks and produces the same snapshot at the recorded final tick", () => {
    const eOriginal = makeTracerEngine();
    playTracerUntilEnemySpawned(eOriginal);
    const bundle = eOriginal.saveState({ format: "transcript" });
    const originalFinalSnap = eOriginal.snapshot();
    eOriginal.dispose();

    const eRestored = makeTracerEngine();
    eRestored.loadState(bundle);
    const restoredFinalSnap = eRestored.snapshot();
    eRestored.dispose();

    expect(restoredFinalSnap).toBe(originalFinalSnap);
  });
});

describe("saveState / loadState — lifecycle semantics", () => {
  it("mid-Scenario loadState ends the previous Scenario — entities replaced and tick counter set to bundle's tick", () => {
    const eOriginal = makeTracerEngine();
    playTracerUntilEnemySpawned(eOriginal);
    const bundle = eOriginal.saveState({ format: "snapshot" });
    eOriginal.dispose();

    const eRestored = makeTracerEngine();
    // Start a different in-progress play through the same scenario.
    eRestored.loadScenario("tracer");
    eRestored.placeTower("archer", { x: 2, y: 0 });
    // Now restore over the in-progress scenario.
    eRestored.loadState(bundle);
    const restoredSnap = JSON.parse(eRestored.snapshot()) as { tick: number };
    expect(restoredSnap.tick).toBe(5);
    eRestored.dispose();
  });

  it("dispose then saveState throws EngineDisposedError", () => {
    const engine = makeTracerEngine();
    engine.loadScenario("tracer");
    engine.dispose();
    expect(() => engine.saveState({ format: "snapshot" })).toThrow(EngineDisposedError);
  });

  it("dispose then loadState throws EngineDisposedError", () => {
    const engineA = makeTracerEngine();
    playTracerUntilEnemySpawned(engineA);
    const bundle = engineA.saveState({ format: "snapshot" });
    engineA.dispose();

    const engineB = makeTracerEngine();
    engineB.dispose();
    expect(() => engineB.loadState(bundle)).toThrow(EngineDisposedError);
  });
});

describe("saveState / loadState — across the full built-in bundle", () => {
  // Exercises upgrades + sells + multi-tick combat, covering the plugins shipped
  // to date (combat, movement, projectiles, waves, upgrades, sells) per the
  // Slice 14 acceptance criteria.
  function playUpgradesScenario(engine: Engine): void {
    engine.loadScenario("upgradesScenario");
    expect(engine.placeTower("archer", { x: 4, y: 0 }).ok).toBe(true);
    expect(engine.purchaseUpgrade("tower:archer:4,0", "damage-boost").ok).toBe(true);
    expect(engine.purchaseUpgrade("tower:archer:4,0", "branch-a").ok).toBe(true);
    expect(engine.sendNextWave().ok).toBe(true);
    for (let i = 0; i < 12; i++) engine.tick(0.1);
  }

  it("snapshot round-trip preserves upgrades + sells state through next-tick determinism", () => {
    const eOriginal = createEngine(buildUpgradesRegistry(), {
      plugins: builtInBundle,
      seed: 99,
    });
    playUpgradesScenario(eOriginal);
    const bundle = eOriginal.saveState({ format: "snapshot" });
    eOriginal.tick(0.1);
    const next = eOriginal.snapshot();
    eOriginal.dispose();

    const eRestored = createEngine(buildUpgradesRegistry(), {
      plugins: builtInBundle,
      seed: 99,
    });
    eRestored.loadState(bundle);
    eRestored.tick(0.1);
    const restoredNext = eRestored.snapshot();
    eRestored.dispose();

    expect(restoredNext).toBe(next);
  });

  it("transcript replay through upgrades + sells reaches the same recorded final snapshot", () => {
    const eOriginal = createEngine(buildUpgradesRegistry(), {
      plugins: builtInBundle,
      seed: 77,
    });
    playUpgradesScenario(eOriginal);
    // Sell the tower as the final action so the recorded transcript covers a
    // mid-scenario sell — round-tripping must reproduce gold + entity churn.
    expect(eOriginal.sellTower("tower:archer:4,0").ok).toBe(true);
    eOriginal.tick(0.1);
    const bundle = eOriginal.saveState({ format: "transcript" });
    const originalFinal = eOriginal.snapshot();
    eOriginal.dispose();

    const eRestored = createEngine(buildUpgradesRegistry(), {
      plugins: builtInBundle,
      seed: 77,
    });
    eRestored.loadState(bundle);
    const restoredFinal = eRestored.snapshot();
    eRestored.dispose();

    expect(restoredFinal).toBe(originalFinal);
  });
});
