import type { Plugin } from "../../types.js";
import { towersPlugin } from "./towers.js";
import { wavesPlugin } from "./waves.js";
import { movementPlugin } from "./movement.js";
import { combatPlugin } from "./combat.js";
import { winLossPlugin } from "./win-loss.js";

export const builtInBundle: readonly Plugin[] = [
  towersPlugin,
  wavesPlugin,
  movementPlugin,
  combatPlugin,
  winLossPlugin,
];
