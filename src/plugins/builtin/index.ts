import type { Plugin } from "../../types.js";
import { towersPlugin } from "./towers.js";
import { wavesPlugin } from "./waves.js";
import { movementPlugin } from "./movement.js";
import { combatPlugin } from "./combat.js";
import { attackEffectsPlugin } from "./attack-effects.js";
import { winLossPlugin } from "./win-loss.js";

export const builtInBundle: readonly Plugin[] = [
  towersPlugin,
  wavesPlugin,
  movementPlugin,
  attackEffectsPlugin,
  combatPlugin,
  winLossPlugin,
];

export { attackEffectsPlugin } from "./attack-effects.js";
export { combatPlugin } from "./combat.js";
export { movementPlugin } from "./movement.js";
export { towersPlugin } from "./towers.js";
export { wavesPlugin } from "./waves.js";
export { winLossPlugin } from "./win-loss.js";
