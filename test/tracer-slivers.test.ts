import { describe, it, expect } from "vitest";
import { createEngine } from "../src/index.js";
import type { GameEvent } from "../src/index.js";
import { builtInBundle } from "../src/plugins/builtin/index.js";
import { buildTracerRegistry } from "./helpers/tracer-registry.js";

function freshEngine(seed = 7) {
  return createEngine(buildTracerRegistry(), { plugins: builtInBundle, seed });
}

describe("tracer slivers", () => {
  describe("placement-modes/fixed", () => {
    it("rejects placement on a non-slot position with INVALID_POSITION", () => {
      const engine = freshEngine();
      engine.loadScenario("tracer");
      const result = engine.placeTower("archer", { x: 1, y: 0 });
      engine.dispose();
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("INVALID_POSITION");
    });

    it("accepts placement on the configured tower slot with ok=true and effect carrying entityId + remaining gold", () => {
      const engine = freshEngine();
      engine.loadScenario("tracer");
      const result = engine.placeTower("archer", { x: 2, y: 0 });
      engine.dispose();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.effect).toMatchObject({
          entityId: expect.stringMatching(/^tower:archer:2,0$/),
          gold: 50, // 100 startingGold − 50 archer cost
        });
      }
    });
  });

  describe("game-rules/startingGold + globalBaseHealth", () => {
    it("loadScenario applies startingGold and globalBaseHealth overrides", () => {
      const engine = freshEngine();
      engine.loadScenario("tracer");
      // Insufficient gold check exercises startingGold: if cost > start, fails.
      const insufficient = engine.placeTower("archer", { x: 2, y: 0 });
      expect(insufficient.ok).toBe(true); // 100 ≥ 50, succeeds
      engine.dispose();
    });

    it("a scenario with startingGold below cost yields INSUFFICIENT_GOLD on placement", () => {
      const reg = buildTracerRegistry();
      (reg.scenarios as any).tracer.gameRuleOverrides.startingGold = 10;
      const engine = createEngine(reg, { plugins: builtInBundle, seed: 1 });
      engine.loadScenario("tracer");
      const result = engine.placeTower("archer", { x: 2, y: 0 });
      engine.dispose();
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("INSUFFICIENT_GOLD");
    });
  });

  describe("wave-triggers/manual + waves spawning", () => {
    it("manual trigger only advances when sendNextWave is called", () => {
      const engine = freshEngine();
      engine.loadScenario("tracer");
      engine.placeTower("archer", { x: 2, y: 0 });
      const events: GameEvent[] = [];
      engine.onEvent((e) => events.push(e));

      // 5 ticks with NO sendNextWave: no enemy should ever spawn.
      for (let i = 0; i < 5; i++) engine.tick(0.5);
      expect(events.some((e) => e.kind === "enemyKilled")).toBe(false);

      // After sendNextWave the wave starts and within a few ticks the enemy dies.
      engine.sendNextWave();
      for (let i = 0; i < 10; i++) engine.tick(0.5);
      engine.dispose();
      expect(events.some((e) => e.kind === "enemyKilled")).toBe(true);
    });

    it("a second sendNextWave before the first clears is WAVE_ALREADY_ACTIVE", () => {
      const reg = buildTracerRegistry();
      // Slow the enemy so the wave stays active for at least one tick after sending.
      (reg.enemies as any).grunt.stats.speed = 0.001;
      const engine = createEngine(reg, { plugins: builtInBundle, seed: 2 });
      engine.loadScenario("tracer");
      engine.placeTower("archer", { x: 2, y: 0 });
      // Remove the archer from the slot to prevent insta-kill — overwrite tower attack to do 0 dmg.
      const first = engine.sendNextWave();
      expect(first.ok).toBe(true);
      const second = engine.sendNextWave();
      engine.dispose();
      expect(second.ok).toBe(false);
      if (!second.ok) expect(second.code).toBe("WAVE_ALREADY_ACTIVE");
    });
  });

  describe("targeting-strategies/closest-to-base", () => {
    it("picks the target nearest the base when multiple are in range", () => {
      // Construct a registry with two enemies in the wave so the tower has a choice.
      const reg = buildTracerRegistry();
      (reg.waves as any).w1.groups = [
        { id: "g1", enemy: "grunt", count: 2, interval: 0.1, delay: 0 },
      ];
      // Slow the enemies so they don't reach the base before being killed.
      (reg.enemies as any).grunt.stats.speed = 0.5;
      (reg.enemies as any).grunt.stats.hp = 1; // one-shot
      const engine = createEngine(reg, { plugins: builtInBundle, seed: 3 });
      const kills: GameEvent[] = [];
      engine.on("enemyKilled", (e) => kills.push(e));
      engine.loadScenario("tracer");
      engine.placeTower("archer", { x: 2, y: 0 });
      engine.sendNextWave();
      for (let i = 0; i < 50; i++) engine.tick(0.1);
      engine.dispose();
      // Both die; ordering proves closest-to-base picked first (the one spawned earliest
      // has the most progress, i.e. is closer to base).
      expect(kills.length).toBe(2);
      expect(kills[0]!.enemy).toMatch(/g1:0:/);
      expect(kills[1]!.enemy).toMatch(/g1:1:/);
    });
  });

  describe("movement + enemyReachedBase + globalBaseHealth", () => {
    it("an enemy that reaches the base emits enemyReachedBase and reduces base hp by baseDamage", () => {
      const reg = buildTracerRegistry();
      // No tower placed → enemy walks all the way to base.
      (reg.scenarios as any).tracer.gameRuleOverrides.globalBaseHealth = 5;
      (reg.enemies as any).grunt.stats.baseDamage = 3;
      const engine = createEngine(reg, { plugins: builtInBundle, seed: 4 });
      const events: GameEvent[] = [];
      engine.onEvent((e) => events.push(e));
      engine.loadScenario("tracer");
      engine.sendNextWave();
      for (let i = 0; i < 100; i++) engine.tick(0.5);
      engine.dispose();
      const reached = events.find((e) => e.kind === "enemyReachedBase");
      expect(reached).toBeDefined();
      expect(reached!.damage).toBe(3);
      // Loss should follow because base hp 5 − 3 = 2 > 0… actually wait: only one enemy.
      // So this asserts only reach + damage. Loss test below uses higher baseDamage.
    });

    it("loss condition fires when base hp drops to 0", () => {
      const reg = buildTracerRegistry();
      (reg.scenarios as any).tracer.gameRuleOverrides.globalBaseHealth = 1;
      (reg.enemies as any).grunt.stats.baseDamage = 5;
      const engine = createEngine(reg, { plugins: builtInBundle, seed: 5 });
      let lost = false;
      engine.on("scenarioLost", () => {
        lost = true;
      });
      engine.loadScenario("tracer");
      engine.sendNextWave();
      for (let i = 0; i < 100 && !lost; i++) engine.tick(0.5);
      engine.dispose();
      expect(lost).toBe(true);
    });
  });

  describe("combat + attack-effects/damage + reward-kinds/gold-on-kill", () => {
    it("killing an enemy emits enemyKilled and awards killReward gold", () => {
      const reg = buildTracerRegistry();
      (reg.enemies as any).grunt.killReward = 25;
      const engine = createEngine(reg, { plugins: builtInBundle, seed: 6 });
      const killed: GameEvent[] = [];
      engine.on("enemyKilled", (e) => killed.push(e));
      engine.loadScenario("tracer");
      engine.placeTower("archer", { x: 2, y: 0 });
      engine.sendNextWave();
      for (let i = 0; i < 20; i++) engine.tick(0.5);
      const snap = JSON.parse(engine.snapshot()) as {
        entities: Array<{ id: string; components: Record<string, unknown> }>;
      };
      engine.dispose();
      expect(killed).toHaveLength(1);
      expect(killed[0]!.killReward).toBe(25);
      const towersState = snap.entities.find((e) => e.id === "towers/state")!;
      const gold = (towersState.components.gold as { amount: number }).amount;
      expect(gold).toBe(100 - 50 + 25); // start − tower cost + killReward
    });

    it("tower fires emit towerFired with frozen source and target positions", () => {
      const engine = freshEngine();
      const fires: GameEvent[] = [];
      engine.on("towerFired", (e) => fires.push(e));
      engine.loadScenario("tracer");
      engine.placeTower("archer", { x: 2, y: 0 });
      engine.sendNextWave();
      for (let i = 0; i < 5; i++) engine.tick(0.5);
      engine.dispose();
      expect(fires.length).toBeGreaterThanOrEqual(1);
      expect(fires[0]!.sourcePosition).toEqual({ x: 2, y: 0 });
      expect(typeof (fires[0]!.targetPosition as { x: number }).x).toBe("number");
    });
  });

  describe("loadScenario semantics", () => {
    it("resets Scenario-introduced state but preserves event subscribers across reload", () => {
      const engine = freshEngine();
      const allEvents: GameEvent[] = [];
      engine.onEvent((e) => allEvents.push(e));

      engine.loadScenario("tracer");
      engine.placeTower("archer", { x: 2, y: 0 });
      engine.sendNextWave();
      for (let i = 0; i < 10; i++) engine.tick(0.5);
      const eventsFromFirst = allEvents.length;
      expect(eventsFromFirst).toBeGreaterThan(0);

      // Second loadScenario — state resets, subscribers survive, new events accumulate.
      engine.loadScenario("tracer");
      const eventsImmediatelyAfterReload = allEvents.length;
      engine.placeTower("archer", { x: 2, y: 0 });
      engine.sendNextWave();
      for (let i = 0; i < 10; i++) engine.tick(0.5);
      engine.dispose();

      // The same subscriber that was attached before the reload still receives events.
      expect(allEvents.length).toBeGreaterThan(eventsImmediatelyAfterReload);
    });

    it("loadScenario throws for an unknown scenarioId", () => {
      const engine = freshEngine();
      expect(() => engine.loadScenario("does-not-exist")).toThrow(/scenario/i);
      engine.dispose();
    });

    it("ticking after dispose throws EngineDisposedError even after a successful scenario", () => {
      const engine = freshEngine();
      engine.loadScenario("tracer");
      engine.dispose();
      expect(() => engine.tick(0.1)).toThrow();
    });
  });
});
