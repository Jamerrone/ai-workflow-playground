import type { ConfigRegistry } from "../../src/index.js";

export function buildTracerRegistry(): ConfigRegistry {
  return {
    components: {},
    entityKinds: {},
    maps: {
      "tracer-map": {
        width: 5,
        height: 1,
        paths: [
          {
            id: "p1",
            kind: "ground",
            waypoints: [
              { x: 0, y: 0 },
              { x: 4, y: 0 },
            ],
          },
        ],
        bases: [{ id: "b1", position: { x: 4, y: 0 } }],
        towerSlots: [{ x: 2, y: 0 }],
        placementMode: { kind: "fixed" },
      },
    },
    towers: {
      archer: {
        cost: 50,
        targeting: { kind: "closest-to-base" },
        attacks: [
          {
            id: "shot",
            stats: { range: 3, cooldown: 0.5 },
            targetFilter: { require: [], exclude: [] },
            effects: [{ kind: "damage", stats: { amount: 10 } }],
          },
        ],
      },
    },
    enemies: {
      grunt: {
        tags: ["ground"],
        stats: { hp: 10, speed: 1, baseDamage: 1 },
        killReward: 10,
      },
    },
    waves: {
      "w1": {
        groups: [
          { id: "g1", enemy: "grunt", count: 1, interval: 0, delay: 0 },
        ],
      },
    },
    scenarios: {
      tracer: {
        map: "tracer-map",
        waves: [{ id: "w1", pathBindings: { g1: "p1" } }],
        waveTrigger: { kind: "manual" },
        gameRuleOverrides: {
          globalBaseHealth: 10,
          startingGold: 100,
        },
      },
    },
    upgrades: {},
    difficulties: {},
    gameRules: {},
  };
}
