import { describe, it, expect } from "vitest";
import { buildRegistry, createEngine } from "../src/index.js";
import type { ConfigRegistry, GameEvent, LoaderInput } from "../src/index.js";
import { builtInBundle } from "../src/plugins/builtin/index.js";
import { buildTracerRegistry } from "./helpers/tracer-registry.js";

function multiEnemyRegistry(): ConfigRegistry {
  const reg = buildTracerRegistry();
  (reg.maps as any)["tracer-map"] = {
    width: 7,
    height: 1,
    paths: [
      {
        id: "p1",
        kind: "ground",
        waypoints: [
          { x: 0, y: 0 },
          { x: 6, y: 0 },
        ],
      },
    ],
    bases: [{ id: "b1", position: { x: 6, y: 0 } }],
    towerSlots: [{ x: 3, y: 0 }],
    placementMode: { kind: "fixed" },
  };
  (reg.towers as any).archer.attacks[0].stats.range = 10;
  (reg.towers as any).archer.attacks[0].stats.damage = 1;
  (reg.towers as any).archer.attacks[0].effects = [{ kind: "damage", stats: { amount: 1 } }];
  // Three enemies (a, b, c) with distinct hp; speed 0 to keep them in place.
  (reg.enemies as any).a = {
    tags: ["ground"],
    stats: { hp: 30, speed: 0, baseDamage: 0 },
    killReward: 0,
  };
  (reg.enemies as any).b = {
    tags: ["ground"],
    stats: { hp: 60, speed: 0, baseDamage: 0 },
    killReward: 0,
  };
  (reg.enemies as any).c = {
    tags: ["ground"],
    stats: { hp: 10, speed: 0, baseDamage: 0 },
    killReward: 0,
  };
  (reg.waves as any).w1 = {
    groups: [
      { id: "ga", enemy: "a", count: 1, interval: 0, delay: 0 },
      { id: "gb", enemy: "b", count: 1, interval: 0, delay: 0 },
      { id: "gc", enemy: "c", count: 1, interval: 0, delay: 0 },
    ],
  };
  (reg.scenarios as any).tracer.waves = [
    { id: "w1", pathBindings: { ga: "p1", gb: "p1", gc: "p1" } },
  ];
  return reg;
}

function placedTowerId(): string {
  // Tower id format from towers plugin: `tower:<archetype>:<x>,<y>`.
  return "tower:archer:3,0";
}

function fireAndCollect(
  setupTargeting: (reg: ConfigRegistry) => void,
  afterPlacement: (engine: ReturnType<typeof createEngine>) => void = () => {},
): { events: GameEvent[]; engine: ReturnType<typeof createEngine> } {
  const reg = multiEnemyRegistry();
  setupTargeting(reg);
  const engine = createEngine(reg, { plugins: builtInBundle, seed: 5 });
  const fires: GameEvent[] = [];
  engine.on("towerFired", (e) => fires.push(e));
  engine.loadScenario("tracer");
  engine.placeTower("archer", { x: 3, y: 0 });
  afterPlacement(engine);
  engine.sendNextWave();
  for (let i = 0; i < 5 && fires.length === 0; i++) engine.tick(0.5);
  return { events: fires, engine };
}

describe("overrideTargeting Player Action (Slice 11)", () => {
  it("changes a Tower's TargetingStrategy at runtime", () => {
    // Archer ships with closest-to-base targeting; override to lowest-hp,
    // which should target enemy 'c' (hp 10).
    const reg = multiEnemyRegistry();
    const engine = createEngine(reg, { plugins: builtInBundle, seed: 6 });
    const fires: GameEvent[] = [];
    engine.on("towerFired", (e) => fires.push(e));
    engine.loadScenario("tracer");
    engine.placeTower("archer", { x: 3, y: 0 });
    // Override BEFORE sendNextWave so the next firing tick already uses the new strategy.
    const result = engine.overrideTargeting(placedTowerId(), { kind: "lowest-hp" });
    expect(result.ok).toBe(true);
    engine.sendNextWave();
    for (let i = 0; i < 5 && fires.length === 0; i++) engine.tick(0.5);
    engine.dispose();
    expect(fires.length).toBeGreaterThan(0);
    expect(fires[0]!.target).toMatch(/^enemy:gc:/);
  });

  it("UNKNOWN_TOWER — fails when the tower entity does not exist", () => {
    const reg = multiEnemyRegistry();
    const engine = createEngine(reg, { plugins: builtInBundle, seed: 7 });
    engine.loadScenario("tracer");
    const result = engine.overrideTargeting("tower:missing:0,0", { kind: "lowest-hp" });
    engine.dispose();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("UNKNOWN_TOWER");
  });

  it("UNKNOWN_STRATEGY — fails when the strategy kind is not registered", () => {
    const reg = multiEnemyRegistry();
    const engine = createEngine(reg, { plugins: builtInBundle, seed: 8 });
    engine.loadScenario("tracer");
    engine.placeTower("archer", { x: 3, y: 0 });
    const result = engine.overrideTargeting(placedTowerId(), { kind: "no-such-strategy" });
    engine.dispose();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("UNKNOWN_STRATEGY");
  });

  it("string-shorthand accepts a bare strategy name and matches the object form", () => {
    // Object form.
    const objRun = fireAndCollect(
      () => {},
      (engine) => {
        engine.overrideTargeting(placedTowerId(), { kind: "lowest-hp" });
      },
    );
    expect(objRun.events.length).toBeGreaterThan(0);
    const objTarget = objRun.events[0]!.target;
    objRun.engine.dispose();

    // String shorthand.
    const strRun = fireAndCollect(
      () => {},
      (engine) => {
        engine.overrideTargeting(placedTowerId(), "lowest-hp");
      },
    );
    expect(strRun.events.length).toBeGreaterThan(0);
    expect(strRun.events[0]!.target).toBe(objTarget);
    strRun.engine.dispose();
  });

  it("dispatch and the overrideTargeting shortcut produce equivalent effects", () => {
    const reg = multiEnemyRegistry();
    const engine = createEngine(reg, { plugins: builtInBundle, seed: 9 });
    engine.loadScenario("tracer");
    engine.placeTower("archer", { x: 3, y: 0 });
    const viaShortcut = engine.overrideTargeting(placedTowerId(), "highest-hp");
    const viaDispatch = engine.dispatch({
      kind: "overrideTargeting",
      tower: placedTowerId(),
      strategy: "highest-hp",
    });
    engine.dispose();
    expect(viaShortcut.ok).toBe(true);
    expect(viaDispatch.ok).toBe(true);
  });
});

describe("Slice 11: multi-path Scenarios", () => {
  function twinPathRegistry(): ConfigRegistry {
    return {
      components: {},
      entityKinds: {},
      maps: {
        twin: {
          width: 20,
          height: 10,
          paths: [
            {
              id: "ground-path",
              kind: "ground",
              waypoints: [
                { x: 0, y: 1 },
                { x: 19, y: 1 },
              ],
            },
            {
              id: "air-path",
              kind: "flying",
              waypoints: [
                { x: 0, y: 8 },
                { x: 19, y: 8 },
              ],
            },
          ],
          bases: [
            { id: "b1", position: { x: 19, y: 1 } },
            { id: "b2", position: { x: 19, y: 8 } },
          ],
          towerSlots: [],
          placementMode: { kind: "fixed" },
        },
      },
      towers: {},
      enemies: {
        grunt: {
          tags: ["ground"],
          stats: { hp: 1, speed: 0.001, baseDamage: 0 },
          killReward: 0,
        },
        bat: {
          tags: ["flying"],
          stats: { hp: 1, speed: 0.001, baseDamage: 0 },
          killReward: 0,
        },
      },
      summons: {},
      waves: {
        mixed: {
          groups: [
            { id: "gground", enemy: "grunt", count: 1, interval: 0, delay: 0 },
            { id: "gair", enemy: "bat", count: 1, interval: 0, delay: 0 },
          ],
        },
      },
      scenarios: {
        s: {
          map: "twin",
          waves: [
            {
              id: "mixed",
              pathBindings: { gground: "ground-path", gair: "air-path" },
            },
          ],
          waveTrigger: { kind: "manual" },
          gameRuleOverrides: { globalBaseHealth: 10000, startingGold: 0 },
        },
      },
      upgrades: {},
      difficulties: {},
      gameRules: {},
    };
  }

  it("validates and runs a Scenario with two Paths and per-group bindings", () => {
    const reg = twinPathRegistry();
    const r = buildRegistry(reg as unknown as LoaderInput);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const engine = createEngine(r.registry, { plugins: builtInBundle, seed: 10 });
    engine.loadScenario("s");
    engine.sendNextWave();
    engine.tick(0.001);
    const snap = JSON.parse(engine.snapshot()) as {
      entities: Array<{ id: string; components: Record<string, unknown> }>;
    };
    engine.dispose();
    const enemies = snap.entities.filter((e) => e.id.startsWith("enemy:"));
    expect(enemies.length).toBe(2);
    const byArche = new Map<string, string>();
    for (const e of enemies) {
      const en = e.components.enemy as { archetype: string };
      const pp = e.components.pathProgress as { pathId: string };
      byArche.set(en.archetype, pp.pathId);
    }
    expect(byArche.get("grunt")).toBe("ground-path");
    expect(byArche.get("bat")).toBe("air-path");
  });
});

describe("Slice 11: diagonal-waypoint rejection (Loader)", () => {
  it("raises a documented error when a Path has diagonal consecutive waypoints", () => {
    const reg = buildTracerRegistry();
    (reg.maps as any)["tracer-map"].paths[0].waypoints = [
      { x: 0, y: 0 },
      { x: 2, y: 2 }, // diagonal: dx=2, dy=2
    ];
    const r = buildRegistry(reg as unknown as LoaderInput);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const diagErr = r.errors.find(
        (e) =>
          e.path.startsWith("maps.tracer-map.paths") &&
          /diagonal/i.test(e.message),
      );
      expect(diagErr).toBeDefined();
    }
  });
});

describe("Slice 11: tag-vocabulary consistency", () => {
  it("the 'flying' tag both allows an Enemy onto an aerial Path and matches an Attack targetFilter.require", () => {
    // Two enemies — flying and ground — on twin paths. Tower fires only on
    // enemies whose tags include 'flying'.
    const reg: ConfigRegistry = {
      components: {},
      entityKinds: {},
      maps: {
        twin: {
          width: 20,
          height: 10,
          paths: [
            {
              id: "ground-path",
              kind: "ground",
              waypoints: [
                { x: 0, y: 1 },
                { x: 19, y: 1 },
              ],
            },
            {
              id: "air-path",
              kind: "flying",
              waypoints: [
                { x: 0, y: 4 },
                { x: 19, y: 4 },
              ],
            },
          ],
          bases: [
            { id: "b1", position: { x: 19, y: 1 } },
            { id: "b2", position: { x: 19, y: 4 } },
          ],
          towerSlots: [{ x: 3, y: 2 }],
          placementMode: { kind: "fixed" },
        },
      },
      towers: {
        aa: {
          cost: 0,
          targeting: { kind: "closest-to-base" },
          attacks: [
            {
              id: "shot",
              stats: { range: 20, cooldown: 0.5, damage: 1 },
              targetFilter: { require: ["flying"], exclude: [] },
              effects: [{ kind: "damage", stats: { amount: 1 } }],
            },
          ],
        },
      },
      enemies: {
        grunt: {
          tags: ["ground"],
          stats: { hp: 100, speed: 0, baseDamage: 0 },
          killReward: 0,
        },
        bat: {
          tags: ["flying"],
          stats: { hp: 100, speed: 0, baseDamage: 0 },
          killReward: 0,
        },
      },
      summons: {},
      waves: {
        mixed: {
          groups: [
            { id: "gg", enemy: "grunt", count: 1, interval: 0, delay: 0 },
            { id: "gb", enemy: "bat", count: 1, interval: 0, delay: 0 },
          ],
        },
      },
      scenarios: {
        s: {
          map: "twin",
          waves: [
            { id: "mixed", pathBindings: { gg: "ground-path", gb: "air-path" } },
          ],
          waveTrigger: { kind: "manual" },
          gameRuleOverrides: { globalBaseHealth: 10000, startingGold: 0 },
        },
      },
      upgrades: {},
      difficulties: {},
      gameRules: {},
    };
    // Sanity: registry validates (path binding tag consistency is enforced
    // because each enemy has the required tag for its bound path).
    const r = buildRegistry(reg as unknown as LoaderInput);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const engine = createEngine(r.registry, { plugins: builtInBundle, seed: 11 });
    const fires: GameEvent[] = [];
    engine.on("towerFired", (e) => fires.push(e));
    engine.loadScenario("s");
    engine.placeTower("aa", { x: 3, y: 2 });
    engine.sendNextWave();
    // Tick until at least one fire happens.
    for (let i = 0; i < 10 && fires.length === 0; i++) engine.tick(0.5);
    engine.dispose();
    expect(fires.length).toBeGreaterThan(0);
    // Every fire targets a flying enemy — never a ground enemy.
    for (const f of fires) {
      expect(f.target as string).toMatch(/^enemy:gb:/);
    }
  });
});
