import { describe, it, expect } from "vitest";
import { createEngine, EngineDisposedError } from "../src/index.js";
import { emptyRegistry } from "./helpers/empty-registry.js";

describe("dispose", () => {
  it("subsequent method calls throw EngineDisposedError", () => {
    const engine = createEngine(emptyRegistry(), { plugins: [], seed: 0 });
    engine.dispose();
    expect(() => engine.tick(0.1)).toThrow(EngineDisposedError);
  });

  it("double dispose is a no-op", () => {
    const engine = createEngine(emptyRegistry(), { plugins: [], seed: 0 });
    engine.dispose();
    expect(() => engine.dispose()).not.toThrow();
  });
});
