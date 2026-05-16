import { describe, it, expect } from "vitest";
import { withTickMath } from "../src/kernel/math-proxy.js";
import { createEngine, Phase } from "../src/index.js";
import type { Plugin } from "../src/index.js";
import { emptyRegistry } from "./helpers/empty-registry.js";

describe("dev-mode Math proxy — forbidden functions", () => {
  const FORBIDDEN = [
    "sin", "cos", "tan",
    "asin", "acos", "atan", "atan2",
    "exp", "log",
    "random",
  ] as const;

  for (const name of FORBIDDEN) {
    it(`Math.${name}() throws in tick code with System id in message`, () => {
      const SYSTEM_ID = "test/forbidden-math";
      expect(() =>
        withTickMath(SYSTEM_ID, () => (Math as unknown as Record<string, () => number>)[name]!()),
      ).toThrow(new RegExp(`${name}.*${SYSTEM_ID}|${SYSTEM_ID}.*${name}`, "i"));
    });
  }

  it("Math.pow() with non-integer exponent throws with System id in message", () => {
    const SYSTEM_ID = "test/pow-proxy";
    expect(() =>
      withTickMath(SYSTEM_ID, () => Math.pow(2, 0.5)),
    ).toThrow(new RegExp(`pow|${SYSTEM_ID}`, "i"));
  });
});

describe("dev-mode Math proxy — allowed functions", () => {
  it("Math.sqrt is accessible and returns correct results", () => {
    expect(withTickMath("test/sys", () => Math.sqrt(4))).toBe(2);
  });

  it("Math.abs is accessible and returns correct results", () => {
    expect(withTickMath("test/sys", () => Math.abs(-5))).toBe(5);
  });

  it("Math.floor / ceil / round / trunc are accessible", () => {
    withTickMath("test/sys", () => {
      expect(Math.floor(1.7)).toBe(1);
      expect(Math.ceil(1.2)).toBe(2);
      expect(Math.round(1.5)).toBe(2);
      expect(Math.trunc(-1.9)).toBe(-1);
    });
  });

  it("Math.pow() with integer exponent is allowed", () => {
    expect(withTickMath("test/sys", () => Math.pow(2, 3))).toBe(8);
  });

  it("Math.pow() with exponent 0 is allowed", () => {
    expect(withTickMath("test/sys", () => Math.pow(5, 0))).toBe(1);
  });

  it("Math.min and Math.max are accessible", () => {
    withTickMath("test/sys", () => {
      expect(Math.min(1, 2, 3)).toBe(1);
      expect(Math.max(1, 2, 3)).toBe(3);
    });
  });

  it("Math.PI and other constants are accessible", () => {
    expect(withTickMath("test/sys", () => Math.PI)).toBeCloseTo(3.14159, 4);
  });

  it("Math is restored to original after withTickMath returns", () => {
    const originalSin = Math.sin;
    withTickMath("test/sys", () => Math.abs(1));
    // After the call, Math.sin should be the real one again.
    expect(Math.sin).toBe(originalSin);
  });

  it("Math is restored even when the function throws", () => {
    const originalSin = Math.sin;
    expect(() => withTickMath("test/sys", () => Math.sin(0))).toThrow();
    expect(Math.sin).toBe(originalSin);
  });
});

describe("dev-mode Math proxy — engine integration", () => {
  it("a System that calls Math.sin throws with the System id in the message", () => {
    const plugin: Plugin = {
      id: "test/sin-plugin",
      register(api) {
        api.registerSystem({
          id: "test/sin-system",
          phase: Phase.Simulation,
          reads: [],
          writes: [],
          run() {
            Math.sin(1); // forbidden
          },
        });
      },
    };

    const registry = {
      ...emptyRegistry(),
      maps: { m: { width: 1, height: 1, paths: [], bases: [], placementMode: { kind: "fixed" } } },
      scenarios: { s: { map: "m", waves: [], waveTrigger: { kind: "manual" } } },
    };
    const engine = createEngine(registry, { plugins: [plugin], seed: 0 });
    engine.loadScenario("s");
    expect(() => engine.tick(0.1)).toThrow(/test\/sin-system/);
    engine.dispose();
  });

  it("a System that calls Math.random throws with the System id in the message", () => {
    const plugin: Plugin = {
      id: "test/random-plugin",
      register(api) {
        api.registerSystem({
          id: "test/random-system",
          phase: Phase.Simulation,
          reads: [],
          writes: [],
          run() {
            Math.random(); // forbidden
          },
        });
      },
    };

    const registry = {
      ...emptyRegistry(),
      maps: { m: { width: 1, height: 1, paths: [], bases: [], placementMode: { kind: "fixed" } } },
      scenarios: { s: { map: "m", waves: [], waveTrigger: { kind: "manual" } } },
    };
    const engine = createEngine(registry, { plugins: [plugin], seed: 0 });
    engine.loadScenario("s");
    expect(() => engine.tick(0.1)).toThrow(/test\/random-system/);
    engine.dispose();
  });

  it("a System that uses only allowed Math functions does not throw", () => {
    const plugin: Plugin = {
      id: "test/allowed-plugin",
      register(api) {
        api.registerSystem({
          id: "test/allowed-system",
          phase: Phase.Simulation,
          reads: [],
          writes: [],
          run() {
            const _ = Math.abs(-1) + Math.sqrt(4) + Math.floor(1.5);
            void _;
          },
        });
      },
    };

    const registry = {
      ...emptyRegistry(),
      maps: { m: { width: 1, height: 1, paths: [], bases: [], placementMode: { kind: "fixed" } } },
      scenarios: { s: { map: "m", waves: [], waveTrigger: { kind: "manual" } } },
    };
    const engine = createEngine(registry, { plugins: [plugin], seed: 0 });
    engine.loadScenario("s");
    expect(() => engine.tick(0.1)).not.toThrow();
    engine.dispose();
  });
});
