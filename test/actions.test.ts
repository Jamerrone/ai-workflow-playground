import { describe, it, expect } from "vitest";
import { createEngine } from "../src/index.js";
import { emptyRegistry } from "./helpers/empty-registry.js";

describe("player actions", () => {
  it("placeTower returns a structured failure without throwing when no scenario is loaded", () => {
    const engine = createEngine(emptyRegistry(), { plugins: [], seed: 0 });
    const result = engine.placeTower("archer", { x: 0, y: 0 });
    engine.dispose();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("NO_SCENARIO_LOADED");
      expect(typeof result.message).toBe("string");
    }
  });

  it("engine.dispatch produces the same result as the placeTower shortcut", () => {
    const engine = createEngine(emptyRegistry(), { plugins: [], seed: 0 });
    const viaMethod = engine.placeTower("archer", { x: 0, y: 0 });
    const viaDispatch = engine.dispatch({
      kind: "placeTower",
      tower: "archer",
      position: { x: 0, y: 0 },
    });
    engine.dispose();
    expect(viaMethod).toEqual(viaDispatch);
  });

  it("sendNextWave returns a structured failure without throwing when no scenario is loaded", () => {
    const engine = createEngine(emptyRegistry(), { plugins: [], seed: 0 });
    const result = engine.sendNextWave();
    engine.dispose();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("NO_SCENARIO_LOADED");
  });
});
