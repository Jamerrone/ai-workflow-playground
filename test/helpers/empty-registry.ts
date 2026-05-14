import type { ConfigRegistry } from "../../src/index.js";

export function emptyRegistry(): ConfigRegistry {
  return {
    components: {},
    entityKinds: {},
    maps: {},
    towers: {},
    enemies: {},
    summons: {},
    waves: {},
    scenarios: {},
    upgrades: {},
    difficulties: {},
    gameRules: {},
  };
}
