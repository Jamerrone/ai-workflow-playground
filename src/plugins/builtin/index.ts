import type { Plugin } from "../../types.js";
import { towersPlugin } from "./towers.js";
import { wavesPlugin } from "./waves.js";
import { movementPlugin } from "./movement.js";
import { combatPlugin } from "./combat.js";
import { attackEffectsPlugin } from "./attack-effects.js";
import { projectilesPlugin } from "./projectiles.js";
import { winLossPlugin } from "./win-loss.js";

export {
  attackEffectsPlugin,
  combatPlugin,
  movementPlugin,
  projectilesPlugin,
  towersPlugin,
  wavesPlugin,
  winLossPlugin,
};

export const builtInBundle: readonly Plugin[] = [
  towersPlugin,
  wavesPlugin,
  movementPlugin,
  attackEffectsPlugin,
  projectilesPlugin,
  combatPlugin,
  winLossPlugin,
];
