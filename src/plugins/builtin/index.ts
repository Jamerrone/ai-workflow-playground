import type { Plugin } from "../../types.js";
import { towersPlugin } from "./towers.js";
import { enemiesPlugin } from "./enemies.js";
import { guardsPlugin } from "./guards.js";
import { wavesPlugin } from "./waves.js";
import { movementPlugin } from "./movement.js";
import { combatPlugin } from "./combat.js";
import { attackEffectsPlugin } from "./attack-effects.js";
import { projectilesPlugin } from "./projectiles.js";
import { targetingStrategiesPlugin } from "./targeting-strategies.js";
import { attackSelectionStrategiesPlugin } from "./attack-selection-strategies.js";
import { upgradesPlugin } from "./upgrades.js";
import { winLossPlugin } from "./win-loss.js";
import { mapFeaturesPlugin } from "./map-features.js";

export {
  attackEffectsPlugin,
  attackSelectionStrategiesPlugin,
  combatPlugin,
  enemiesPlugin,
  guardsPlugin,
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
  enemiesPlugin,
  guardsPlugin,
  mapFeaturesPlugin,
  wavesPlugin,
  movementPlugin,
  attackEffectsPlugin,
  projectilesPlugin,
  targetingStrategiesPlugin,
  attackSelectionStrategiesPlugin,
  combatPlugin,
  upgradesPlugin,
  winLossPlugin,
];
