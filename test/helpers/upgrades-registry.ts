import type { ConfigRegistry } from "../../src/index.js";

export function buildUpgradesRegistry(): ConfigRegistry {
  return {
    components: {},
    entityKinds: {},
    maps: {
      "row-9": {
        width: 9,
        height: 1,
        paths: [
          {
            id: "p1",
            kind: "ground",
            waypoints: [
              { x: 0, y: 0 },
              { x: 8, y: 0 },
            ],
          },
        ],
        bases: [{ id: "b1", position: { x: 8, y: 0 } }],
        towerSlots: [{ x: 4, y: 0 }],
        placementMode: { kind: "fixed" },
      },
    },
    towers: {
      archer: {
        cost: 10,
        targeting: { kind: "closest-to-base" },
        upgradeTree: ["damage-boost", "rapid-fire", "branch-a", "branch-b", "needs-boost"],
        attacks: [
          {
            id: "shot",
            stats: { range: 9, cooldown: 1 },
            targetFilter: { require: [], exclude: [] },
            effects: [{ kind: "damage", id: "main", stats: { amount: 5 } }],
          },
        ],
      },
    },
    enemies: {
      grunt: {
        tags: ["ground"],
        stats: { hp: 100, speed: 1, baseDamage: 1 },
        killReward: 0,
      },
    },
    summons: {},
    waves: {
      w1: {
        groups: [{ id: "g1", enemy: "grunt", count: 1, interval: 0, delay: 0 }],
      },
    },
    scenarios: {
      upgradesScenario: {
        map: "row-9",
        waves: [{ id: "w1", pathBindings: { g1: "p1" } }],
        waveTrigger: { kind: "manual" },
        gameRuleOverrides: { globalBaseHealth: 1000, startingGold: 1000 },
      },
    },
    upgrades: {
      "damage-boost": {
        tower: "archer",
        cost: 30,
        ops: [
          { kind: "stat", attackId: "shot", effectId: "main", field: "amount", delta: 10 },
        ],
      },
      "rapid-fire": {
        tower: "archer",
        cost: 50,
        ops: [
          { kind: "attackMutation", attackId: "shot", field: "cooldown", set: 0.25 },
        ],
      },
      "branch-a": {
        tower: "archer",
        cost: 20,
        exclusiveGroup: "branch",
        ops: [
          { kind: "stat", attackId: "shot", effectId: "main", field: "amount", delta: 2 },
        ],
      },
      "branch-b": {
        tower: "archer",
        cost: 20,
        exclusiveGroup: "branch",
        ops: [
          { kind: "stat", attackId: "shot", effectId: "main", field: "amount", delta: 3 },
        ],
      },
      "needs-boost": {
        tower: "archer",
        cost: 10,
        prerequisites: ["damage-boost"],
        ops: [
          { kind: "stat", attackId: "shot", effectId: "main", field: "amount", factor: 2 },
        ],
      },
    },
    difficulties: {},
    gameRules: {},
  };
}
