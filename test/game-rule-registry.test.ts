import { describe, it, expect } from "vitest";
import { createEngine, Phase } from "../src/index.js";
import type { Plugin, SystemContext } from "../src/index.js";
import { emptyRegistry } from "./helpers/empty-registry.js";

describe("GameRule registry", () => {
  it("resolves a registered GameRule's default when no scenario override is present", () => {
    let captured: SystemContext | null = null;
    const probe: Plugin = {
      id: "test/probe",
      register(api) {
        api.registerGameRule({ key: "enemyEngagementCap", default: 3 });
        api.registerSystem({
          id: "test/peek",
          phase: Phase.Simulation,
          reads: [],
          writes: [],
          run(ctx) {
            captured = ctx;
          },
        });
      },
    };
    const registry = {
      ...emptyRegistry(),
      maps: {
        m: { width: 1, height: 1, paths: [], bases: [], placementMode: { kind: "fixed" } },
      },
      scenarios: {
        s: { map: "m", waves: [], waveTrigger: { kind: "manual" } },
      },
    };
    const engine = createEngine(registry, { plugins: [probe], seed: 0 });
    engine.loadScenario("s");
    engine.tick(0.1);
    engine.dispose();

    expect(captured!.gameRules.get("enemyEngagementCap")).toBe(3);
  });

  it("lets a Scenario's gameRuleOverrides override a registered default", () => {
    let captured: SystemContext | null = null;
    const probe: Plugin = {
      id: "test/probe",
      register(api) {
        api.registerGameRule({ key: "enemyEngagementCap", default: 3 });
        api.registerSystem({
          id: "test/peek",
          phase: Phase.Simulation,
          reads: [],
          writes: [],
          run(ctx) {
            captured = ctx;
          },
        });
      },
    };
    const registry = {
      ...emptyRegistry(),
      maps: {
        m: { width: 1, height: 1, paths: [], bases: [], placementMode: { kind: "fixed" } },
      },
      scenarios: {
        s: {
          map: "m",
          waves: [],
          waveTrigger: { kind: "manual" },
          gameRuleOverrides: { enemyEngagementCap: 2 },
        },
      },
    };
    const engine = createEngine(registry, { plugins: [probe], seed: 0 });
    engine.loadScenario("s");
    engine.tick(0.1);
    engine.dispose();

    expect(captured!.gameRules.get("enemyEngagementCap")).toBe(2);
  });

  it("returns undefined for keys no plugin has registered", () => {
    let captured: SystemContext | null = null;
    const probe: Plugin = {
      id: "test/probe",
      register(api) {
        api.registerSystem({
          id: "test/peek",
          phase: Phase.Simulation,
          reads: [],
          writes: [],
          run(ctx) {
            captured = ctx;
          },
        });
      },
    };
    const registry = {
      ...emptyRegistry(),
      maps: {
        m: { width: 1, height: 1, paths: [], bases: [], placementMode: { kind: "fixed" } },
      },
      scenarios: { s: { map: "m", waves: [], waveTrigger: { kind: "manual" } } },
    };
    const engine = createEngine(registry, { plugins: [probe], seed: 0 });
    engine.loadScenario("s");
    engine.tick(0.1);
    engine.dispose();

    expect(captured!.gameRules.get("nonexistent")).toBeUndefined();
  });
});
