export { createEngine } from "./kernel/engine.js";
export { EngineDisposedError } from "./kernel/errors.js";
export { Phase, PHASE_ORDER } from "./types.js";
export type {
  Engine,
  EngineOptions,
  ConfigRegistry,
  Plugin,
  RegistrationApi,
  ComponentDef,
  SystemDef,
  SystemContext,
  GameEvent,
  EventHandler,
  PlayerAction,
  ActionResult,
  Position,
} from "./types.js";
