import type { ConfigRegistry } from "../../src/index.js";

/**
 * Minimal registry for the Guards plugin tracer-bullet: a Barracks Tower
 * archetype carrying a `summon` Component config, plus a `footman` Guard
 * archetype. No waves, no enemies — just enough to exercise placement and
 * the immediate-fill spawn behaviour.
 */
export function buildGuardsRegistry(): ConfigRegistry {
  return {
    components: {},
    entityKinds: {},
    maps: {
      "guards-map": {
        width: 5,
        height: 5,
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
        towerSlots: [{ x: 2, y: 2 }],
        placementMode: { kind: "fixed" },
      },
    },
    towers: {
      barracks: {
        cost: 50,
        targeting: { kind: "closest-to-base" },
        attacks: [],
        components: {
          summon: {
            summons: "footman",
            maxCount: 3,
            respawnCooldown: 5,
            rallyPointRange: 4,
          },
        },
      },
    },
    enemies: {},
    guards: {
      footman: {
        stats: { hp: 20, speed: 1, idleRegen: 1 },
        attacks: [],
      },
    },
    waves: {},
    scenarios: {
      guardsScenario: {
        map: "guards-map",
        waves: [],
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
