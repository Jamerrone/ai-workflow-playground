import type { Plugin } from "../../types.js";
import { towersPlugin } from "./towers.js";
import { wavesPlugin } from "./waves.js";
import { movementPlugin } from "./movement.js";
import { combatPlugin } from "./combat.js";
import { attackEffectsPlugin } from "./attack-effects.js";
import { projectilesPlugin } from "./projectiles.js";
import { targetingStrategiesPlugin } from "./targeting-strategies.js";
import { upgradesPlugin } from "./upgrades.js";
import { winLossPlugin } from "./win-loss.js";
import { mapFeaturesPlugin } from "./map-features.js";

export {
  attackEffectsPlugin,
  combatPlugin,
  mapFeaturesPlugin,
  movementPlugin,
  projectilesPlugin,
  targetingStrategiesPlugin,
  towersPlugin,
  upgradesPlugin,
  wavesPlugin,
  winLossPlugin,
};

export const builtInBundle: readonly Plugin[] = [
  towersPlugin,
  mapFeaturesPlugin,
  wavesPlugin,
  movementPlugin,
  attackEffectsPlugin,
  projectilesPlugin,
  targetingStrategiesPlugin,
  combatPlugin,
  upgradesPlugin,
  winLossPlugin,
];
