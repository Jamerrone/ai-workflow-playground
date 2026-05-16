import { describe, it, expect } from "vitest";
import { createEngine, Phase, PHASE_ORDER } from "../src/index.js";
import type { Plugin } from "../src/index.js";
import { emptyRegistry } from "./helpers/empty-registry.js";

describe("phase enforcement (dev mode)", () => {
  it("throws when a System writes a Component outside the Component's writableIn phase", () => {
    const plugin: Plugin = {
      id: "test/phase-enforcement",
      register(api) {
        api.registerComponent({
          name: "health",
          writableIn: [Phase.Effect], // only writable in Effect phase
        });
        api.registerSystem({
          id: "test/seed",
          phase: Phase.Effect, // allowed phase for seeding the Component
          reads: [],
          writes: ["health"],
          run(ctx) {
            if (ctx.tickIndex === 0) ctx.world.spawn("e1", { health: { hp: 10 } });
          },
        });
        api.registerSystem({
          id: "test/illegalWrite",
          phase: Phase.Reward, // Reward is NOT in writableIn for 'health'
          reads: [],
          writes: ["health"],
          after: ["test/seed"],
          run(ctx) {
            ctx.world.mutate("e1", "health", () => ({ hp: 0 }));
          },
        });
      },
    };

    const engine = createEngine(emptyRegistry(), { plugins: [plugin], seed: 0 });
    expect(() => engine.tick(0.1)).toThrow(/writableIn|phase/i);
    engine.dispose();
  });

  it("allows a System to write a Component when its phase IS in writableIn", () => {
    const plugin: Plugin = {
      id: "test/legal-write",
      register(api) {
        api.registerComponent({
          name: "health",
          writableIn: [Phase.Effect],
        });
        api.registerSystem({
          id: "test/seed",
          phase: Phase.Effect,
          reads: [],
          writes: ["health"],
          run(ctx) {
            if (ctx.tickIndex === 0) ctx.world.spawn("e1", { health: { hp: 10 } });
          },
        });
        api.registerSystem({
          id: "test/legalWrite",
          phase: Phase.Effect,
          reads: [],
          writes: ["health"],
          after: ["test/seed"],
          run(ctx) {
            ctx.world.mutate("e1", "health", () => ({ hp: 0 }));
          },
        });
      },
    };

    const engine = createEngine(emptyRegistry(), { plugins: [plugin], seed: 0 });
    expect(() => engine.tick(0.1)).not.toThrow();
    engine.dispose();
  });
});

describe("phase enforcement — every shipped phase (full fixture)", () => {
  // For each phase X: a component with writableIn:[X] must only be mutable
  // during phase X. Writing it from any other phase must throw.
  //
  // Strategy: pre-spawn the entity during onScenarioLoad (phase === null,
  // no enforcement). Then register a System in the WRONG phase that tries
  // to mutate the component on the first tick — it must throw.
  const crossWriteCases: Array<{
    label: string;
    writableIn: (typeof Phase)[keyof typeof Phase];
    badPhase: (typeof Phase)[keyof typeof Phase];
  }> = [
    { label: "Wave-only → write in Simulation", writableIn: Phase.Wave, badPhase: Phase.Simulation },
    { label: "Simulation-only → write in Effect", writableIn: Phase.Simulation, badPhase: Phase.Effect },
    { label: "Effect-only → write in Reward", writableIn: Phase.Effect, badPhase: Phase.Reward },
    { label: "Reward-only → write in Rule", writableIn: Phase.Reward, badPhase: Phase.Rule },
    { label: "Rule-only → write in Emit", writableIn: Phase.Rule, badPhase: Phase.Emit },
    { label: "Emit-only → write in Wave", writableIn: Phase.Emit, badPhase: Phase.Wave },
  ];

  for (const { label, writableIn, badPhase } of crossWriteCases) {
    it(`throws on cross-phase write: ${label}`, () => {
      const plugin: Plugin = {
        id: `test/phase-${writableIn}`,
        register(api) {
          api.registerComponent({ name: "marker", writableIn: [writableIn] });
          api.onScenarioLoad((ctx) => {
            // Spawn outside any tick phase (no enforcement) so the entity
            // exists when the bad-phase system tries to write it.
            ctx.world.spawn("e1", { marker: { v: 0 } });
          });
          api.registerSystem({
            id: `test/badWriter-${writableIn}`,
            phase: badPhase,
            reads: [],
            writes: ["marker"],
            run(ctx) {
              ctx.world.mutate("e1", "marker", () => ({ v: 1 }));
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
      expect(() => engine.tick(0.1)).toThrow(/writableIn|phase/i);
      engine.dispose();
    });
  }

  it("every phase allows writes to its own component without throwing", () => {
    const plugin: Plugin = {
      id: "test/all-phases-legal",
      register(api) {
        for (const phase of PHASE_ORDER) {
          const compName = `comp-${phase}`;
          api.registerComponent({ name: compName, writableIn: [phase] });
          api.onScenarioLoad((ctx) => {
            ctx.world.spawn(`e-${phase}`, { [compName]: { v: 0 } });
          });
          api.registerSystem({
            id: `test/writer-${phase}`,
            phase,
            reads: [],
            writes: [compName],
            run(ctx) {
              ctx.world.mutate(`e-${phase}`, compName, () => ({ v: 1 }));
            },
          });
        }
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
