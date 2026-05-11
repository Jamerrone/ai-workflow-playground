import { describe, it, expect } from "vitest";
import { createEngine } from "../src/index.js";
import { emptyRegistry } from "./helpers/empty-registry.js";

describe("engine skeleton", () => {
  it("constructs against an empty registry and ticks without throwing", () => {
    const engine = createEngine(emptyRegistry(), { plugins: [], seed: 0 });
    expect(() => engine.tick(0.1)).not.toThrow();
    engine.dispose();
  });
});
