import { describe, it, expect } from "vitest";
import { createEngine } from "../src/index.js";
import { builtInBundle } from "../src/plugins/builtin/index.js";
import { buildTracerRegistry } from "./helpers/tracer-registry.js";

describe("Engine.world", () => {
  it("exposes world with a query method", () => {
    const engine = createEngine(buildTracerRegistry(), { plugins: builtInBundle, seed: 1 });
    expect(typeof engine.world.query).toBe("function");
    engine.dispose();
  });

  it("world.query returns spawned entities after loadScenario", () => {
    const engine = createEngine(buildTracerRegistry(), { plugins: builtInBundle, seed: 1 });
    engine.loadScenario("tracer");
    const all = engine.world.query({});
    expect(all.length).toBeGreaterThan(0);
    engine.dispose();
  });

  it("world.query filters by component", () => {
    const engine = createEngine(buildTracerRegistry(), { plugins: builtInBundle, seed: 1 });
    engine.loadScenario("tracer");
    const bases = engine.world.query({ all: ["bases"] });
    expect(bases).toHaveLength(1);
    engine.dispose();
  });
});
