import type { ConfigRegistry } from "../../src/index.js";

/**
 * A small registry used to drive attack-effects tests. The map is a 9-wide single-row
 * corridor; the only tower slot is at (4,0) so the tower sits in the middle. Enemies
 * spawn at (0,0) and walk toward (8,0). The default attack carries a single damage
 * effect with amount 1 — tests override `effects` per case.
 */
export function buildEffectsRegistry(): ConfigRegistry {
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
        cost: 0,
        targeting: { kind: "closest-to-base" },
        attacks: [
          {
            id: "shot",
            stats: { range: 9, cooldown: 0.5 },
            targetFilter: { require: [], exclude: [] },
            effects: [{ kind: "damage", id: "main", stats: { amount: 1 } }],
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
    waves: {
      w1: {
        groups: [{ id: "g1", enemy: "grunt", count: 1, interval: 0, delay: 0 }],
      },
    },
    scenarios: {
      effects: {
        map: "row-9",
        waves: [{ id: "w1", pathBindings: { g1: "p1" } }],
        waveTrigger: { kind: "manual" },
        gameRuleOverrides: { globalBaseHealth: 1000, startingGold: 0 },
      },
    },
    upgrades: {},
    difficulties: {},
    gameRules: {},
    guards: {},
  };
}
