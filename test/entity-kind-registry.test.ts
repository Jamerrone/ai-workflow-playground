import { describe, it, expect } from "vitest";
import { createEngine, Phase } from "../src/index.js";
import type { ActionContext, Plugin, SystemContext } from "../src/index.js";
import { builtInBundle } from "../src/plugins/builtin/index.js";
import { emptyRegistry } from "./helpers/empty-registry.js";

describe("EntityKind registry", () => {
  it("registers Tower, Enemy, and Projectile EntityKinds via the built-in bundle", () => {
    let captured: ActionContext | null = null;
    const probe: Plugin = {
      id: "test/probe",
      register(api) {
        api.onScenarioLoad((ctx) => {
          captured = ctx;
        });
      },
    };
    const engine = createEngine(
      {
        ...emptyRegistry(),
        maps: {
          m: {
            width: 1,
            height: 1,
            paths: [],
            bases: [],
            placementMode: { kind: "fixed" },
          },
        },
        scenarios: {
          s: { map: "m", waves: [], waveTrigger: { kind: "manual" } },
        },
      },
      { plugins: [...builtInBundle, probe], seed: 0 },
    );
    engine.loadScenario("s");
    engine.dispose();

    const kinds = captured!.entityKinds;
    expect(kinds.has("tower")).toBe(true);
    expect(kinds.has("enemy")).toBe(true);
    expect(kinds.has("projectile")).toBe(true);

    const towerKind = kinds.get("tower")!;
    expect(towerKind.components).toContain("tower");
    expect(towerKind.components).toContain("position");

    const enemyKind = kinds.get("enemy")!;
    expect(enemyKind.components).toContain("enemy");
    expect(enemyKind.components).toContain("position");

    const projectileKind = kinds.get("projectile")!;
    expect(projectileKind.components).toContain("projectile");
    expect(projectileKind.components).toContain("position");
  });

  it("exposes the EntityKind registry to Systems via SystemContext", () => {
    let captured: SystemContext | null = null;
    const towerKindBundle = ["tower-x", "position-x"];
    const probe: Plugin = {
      id: "test/probe",
      register(api) {
        api.registerComponent({ name: "tower-x", writableIn: [Phase.Simulation] });
        api.registerComponent({ name: "position-x", writableIn: [Phase.Simulation] });
        api.registerEntityKind({ kind: "tower-x", components: towerKindBundle });
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
    const engine = createEngine(emptyRegistry(), { plugins: [probe], seed: 0 });
    engine.tick(0.1);
    engine.dispose();

    expect(captured!.entityKinds.get("tower-x")?.components).toEqual(towerKindBundle);
  });

  it("fails fast when an EntityKind references an unregistered Component", () => {
    const bad: Plugin = {
      id: "test/bad",
      register(api) {
        api.registerEntityKind({
          kind: "ghost",
          components: ["nonexistent-component"],
        });
      },
    };
    expect(() =>
      createEngine(emptyRegistry(), { plugins: [bad], seed: 0 }),
    ).toThrow(/nonexistent-component/);
  });

  it("allows a later registration of the same kind to override the earlier one (last-write wins)", () => {
    let captured: SystemContext | null = null;
    const first: Plugin = {
      id: "test/first",
      register(api) {
        api.registerComponent({ name: "c1", writableIn: [Phase.Simulation] });
        api.registerEntityKind({ kind: "thing", components: ["c1"] });
      },
    };
    const second: Plugin = {
      id: "test/second",
      register(api) {
        api.registerComponent({ name: "c2", writableIn: [Phase.Simulation] });
        api.registerEntityKind({ kind: "thing", components: ["c2"] });
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
    const engine = createEngine(emptyRegistry(), {
      plugins: [first, second],
      seed: 0,
    });
    engine.tick(0.1);
    engine.dispose();
    expect(captured!.entityKinds.get("thing")?.components).toEqual(["c2"]);
  });
});
