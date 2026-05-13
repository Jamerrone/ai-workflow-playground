export { createEngine } from "./kernel/engine.js";
export { EngineDisposedError } from "./kernel/errors.js";
export { Phase, PHASE_ORDER } from "./types.js";
export { buildRegistry, formatLoaderErrors } from "./loader/index.js";
export type {
  LoaderError,
  LoaderErrorSource,
  LoaderInput,
  LoaderOptions,
  LoaderResult,
  PluginManifestEntry,
} from "./loader/index.js";
export type {
  Engine,
  EngineOptions,
  ConfigRegistry,
  Plugin,
  RegistrationApi,
  ActionContext,
  ComponentDef,
  EntityKindDef,
  SystemDef,
  SystemContext,
  GameEvent,
  EventHandler,
  PlayerAction,
  ActionResult,
  Position,
  SavedState,
  SaveOptions,
  SnapshotBundle,
  TranscriptBundle,
} from "./types.js";
