import { actionFailure } from "./action-result.js";
import { EngineDisposedError } from "./errors.js";
import { resolveSystemOrder } from "./ordering.js";
import { serializeWorld } from "./snapshot.js";
import { WorldImpl } from "./world.js";
import {
  PHASE_ORDER,
  type ActionContext,
  type ActionHandlerDef,
  type ActionResult,
  type AttackEffectDef,
  type ComponentDef,
  type ConfigRegistry,
  type Engine,
  type EngineOptions,
  type EventHandler,
  type GameEvent,
  type Phase,
  type PlacementModeDef,
  type PlayerAction,
  type Plugin,
  type Position,
  type RegistrationApi,
  type ScenarioLoadHook,
  type SystemDef,
} from "../types.js";

interface Registries {
  components: Map<string, ComponentDef>;
  systemsByPhase: Map<Phase, SystemDef[]>;
  actionHandlers: Map<string, ActionHandlerDef>;
  placementModes: Map<string, PlacementModeDef>;
  attackEffects: Map<string, AttackEffectDef>;
  scenarioLoadHooks: ScenarioLoadHook[];
}

function loadPlugins(plugins: readonly Plugin[]): Registries {
  const components = new Map<string, ComponentDef>();
  const systemsByPhase = new Map<Phase, SystemDef[]>(
    PHASE_ORDER.map((p) => [p, []]),
  );
  const actionHandlers = new Map<string, ActionHandlerDef>();
  const placementModes = new Map<string, PlacementModeDef>();
  const attackEffects = new Map<string, AttackEffectDef>();
  const scenarioLoadHooks: ScenarioLoadHook[] = [];

  const api: RegistrationApi = {
    registerComponent(def) {
      components.set(def.name, def);
    },
    registerSystem(def) {
      systemsByPhase.get(def.phase)!.push(def);
    },
    registerActionHandler(def) {
      actionHandlers.set(def.kind, def);
    },
    registerPlacementMode(def) {
      placementModes.set(def.kind, def);
    },
    registerAttackEffect(def) {
      attackEffects.set(def.kind, def);
    },
    onScenarioLoad(hook) {
      scenarioLoadHooks.push(hook);
    },
  };
  for (const plugin of plugins) plugin.register(api);
  return {
    components,
    systemsByPhase,
    actionHandlers,
    placementModes,
    attackEffects,
    scenarioLoadHooks,
  };
}

export function createEngine(
  registry: ConfigRegistry,
  options: EngineOptions,
): Engine {
  const {
    systemsByPhase,
    components,
    actionHandlers,
    placementModes,
    attackEffects,
    scenarioLoadHooks,
  } = loadPlugins(options.plugins);
  for (const phase of PHASE_ORDER) {
    systemsByPhase.set(phase, resolveSystemOrder(systemsByPhase.get(phase)!));
  }
  const world = new WorldImpl();
  for (const def of components.values()) {
    world.declareComponent(def.name, def.writableIn);
  }

  const anyHandlers: EventHandler[] = [];
  const kindHandlers = new Map<string, EventHandler[]>();
  let pending: GameEvent[] = [];

  const flushTickEvents = () => {
    if (pending.length === 0) return;
    const toDeliver = pending;
    pending = [];
    for (const event of toDeliver) deliver(event);
  };

  const deliver = (event: GameEvent) => {
    for (const h of anyHandlers) h(event);
    const kh = kindHandlers.get(event.kind);
    if (kh) for (const h of kh) h(event);
  };

  let disposed = false;
  let tickIndex = 0;
  let activeScenarioId: string | null = null;
  const assertAlive = () => {
    if (disposed) throw new EngineDisposedError();
  };

  const buildActionContext = (): ActionContext => ({
    world,
    registry,
    scenarioId: activeScenarioId!,
    tickIndex,
    placementModes,
    attackEffects,
    emit(event: GameEvent) {
      // Action-produced events fire synchronously, before dispatch returns (ADR-0016).
      deliver(event);
    },
  });

  const dispatch = (action: PlayerAction): ActionResult => {
    assertAlive();
    if (activeScenarioId === null) {
      return actionFailure("NO_SCENARIO_LOADED", "No scenario is currently active.");
    }
    const handler = actionHandlers.get(action.kind);
    if (!handler) {
      return actionFailure(
        "UNKNOWN_ACTION_KIND",
        `No PlayerActionHandler is registered for kind '${action.kind}'.`,
      );
    }
    return handler.handle(buildActionContext(), action);
  };

  return {
    tick(dt: number) {
      assertAlive();
      const ctx = {
        tickIndex,
        dt,
        world,
        registry,
        scenarioId: activeScenarioId,
        placementModes,
        attackEffects,
        emit(event: GameEvent) {
          pending.push(event);
        },
      };
      for (const phase of PHASE_ORDER) {
        world.setPhase(phase);
        for (const system of systemsByPhase.get(phase)!) {
          system.run(ctx);
        }
      }
      world.setPhase(null);
      flushTickEvents();
      tickIndex++;
    },
    dispose() {
      disposed = true;
      anyHandlers.length = 0;
      kindHandlers.clear();
      pending = [];
    },
    on(kind, handler) {
      assertAlive();
      let list = kindHandlers.get(kind);
      if (!list) {
        list = [];
        kindHandlers.set(kind, list);
      }
      list.push(handler);
      return () => {
        const l = kindHandlers.get(kind);
        if (!l) return;
        const i = l.indexOf(handler);
        if (i >= 0) l.splice(i, 1);
      };
    },
    onEvent(handler) {
      assertAlive();
      anyHandlers.push(handler);
      return () => {
        const i = anyHandlers.indexOf(handler);
        if (i >= 0) anyHandlers.splice(i, 1);
      };
    },
    loadScenario(scenarioId: string) {
      assertAlive();
      const scenario = (registry.scenarios as Record<string, unknown>)[scenarioId];
      if (!scenario) {
        throw new Error(`Unknown scenario '${scenarioId}'`);
      }
      const mapId = (scenario as { map: string }).map;
      const map = (registry.maps as Record<string, unknown>)[mapId];
      if (!map) throw new Error(`Unknown map '${mapId}'`);
      activeScenarioId = scenarioId;
      tickIndex = 0;
      pending = [];
      world.reset();
      // Plugins set up their per-Scenario state. Kernel ships no gameplay.
      const ctx = buildActionContext();
      for (const hook of scenarioLoadHooks) hook(ctx);
    },
    dispatch(action: PlayerAction) {
      return dispatch(action);
    },
    placeTower(towerId: string, position: Position) {
      return dispatch({ kind: "placeTower", tower: towerId, position });
    },
    sendNextWave() {
      return dispatch({ kind: "sendNextWave" });
    },
    snapshot() {
      assertAlive();
      return serializeWorld(world, tickIndex);
    },
  };
}
