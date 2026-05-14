import { actionFailure } from "./action-result.js";
import { EngineDisposedError } from "./errors.js";
import { resolveSystemOrder } from "./ordering.js";
import { deserializeWorld, serializeWorld } from "./snapshot.js";
import { WorldImpl } from "./world.js";
import {
  PHASE_ORDER,
  type ActionContext,
  type ActionHandlerDef,
  type ActionResult,
  type AttackEffectDef,
  type AttackSelectionStrategyDef,
  type ComponentDef,
  type ConfigRegistry,
  type Engine,
  type EntityKindDef,
  type EngineOptions,
  type EventHandler,
  type GameEvent,
  type GameRuleDef,
  type MapFeatureDef,
  type Phase,
  type PlacementModeDef,
  type PlayerAction,
  type Plugin,
  type Position,
  type RegistrationApi,
  type RewardContext,
  type RewardKindDef,
  type SaveOptions,
  type SavedState,
  type ScenarioLoadHook,
  type SystemDef,
  type TargetingStrategyConfig,
  type TargetingStrategyDef,
  type UpgradeOpDef,
} from "../types.js";

interface Registries {
  components: Map<string, ComponentDef>;
  entityKinds: Map<string, EntityKindDef>;
  systemsByPhase: Map<Phase, SystemDef[]>;
  actionHandlers: Map<string, ActionHandlerDef>;
  placementModes: Map<string, PlacementModeDef>;
  mapFeatures: Map<string, MapFeatureDef>;
  attackEffects: Map<string, AttackEffectDef>;
  rewardsByEventKind: Map<string, RewardKindDef[]>;
  targetingStrategies: Map<string, TargetingStrategyDef>;
  attackSelectionStrategies: Map<string, AttackSelectionStrategyDef>;
  upgradeOps: Map<string, UpgradeOpDef>;
  gameRules: Map<string, GameRuleDef>;
  scenarioLoadHooks: ScenarioLoadHook[];
}

function loadPlugins(plugins: readonly Plugin[]): Registries {
  const components = new Map<string, ComponentDef>();
  const entityKinds = new Map<string, EntityKindDef>();
  const systemsByPhase = new Map<Phase, SystemDef[]>(
    PHASE_ORDER.map((p) => [p, []]),
  );
  const actionHandlers = new Map<string, ActionHandlerDef>();
  const placementModes = new Map<string, PlacementModeDef>();
  const mapFeatures = new Map<string, MapFeatureDef>();
  const attackEffects = new Map<string, AttackEffectDef>();
  const rewardsByEventKind = new Map<string, RewardKindDef[]>();
  const targetingStrategies = new Map<string, TargetingStrategyDef>();
  const attackSelectionStrategies = new Map<string, AttackSelectionStrategyDef>();
  const upgradeOps = new Map<string, UpgradeOpDef>();
  const gameRules = new Map<string, GameRuleDef>();
  const scenarioLoadHooks: ScenarioLoadHook[] = [];

  const api: RegistrationApi = {
    registerComponent(def) {
      components.set(def.name, def);
    },
    registerEntityKind(def) {
      entityKinds.set(def.kind, def);
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
    registerMapFeature(def) {
      mapFeatures.set(def.kind, def);
    },
    registerAttackEffect(def) {
      attackEffects.set(def.kind, def);
    },
    registerReward(def) {
      let list = rewardsByEventKind.get(def.eventKind);
      if (!list) {
        list = [];
        rewardsByEventKind.set(def.eventKind, list);
      }
      list.push(def);
    },
    registerTargetingStrategy(def) {
      targetingStrategies.set(def.kind, def);
    },
    registerAttackSelectionStrategy(def) {
      attackSelectionStrategies.set(def.kind, def);
    },
    registerUpgradeOp(def) {
      upgradeOps.set(def.kind, def);
    },
    registerGameRule(def) {
      gameRules.set(def.key, def as GameRuleDef);
    },
    onScenarioLoad(hook) {
      scenarioLoadHooks.push(hook);
    },
  };
  for (const plugin of plugins) plugin.register(api);

  // Fail fast: every Component an EntityKind references must be registered by
  // some (possibly other) plugin. Validated after all plugins load so two
  // plugins can collaborate — e.g. enemiesPlugin registers `kind: "enemy"`
  // referencing Components owned by wavesPlugin.
  for (const ek of entityKinds.values()) {
    for (const c of ek.components) {
      if (!components.has(c)) {
        throw new Error(
          `EntityKind '${ek.kind}' references unregistered Component '${c}'.`,
        );
      }
    }
  }

  return {
    components,
    entityKinds,
    systemsByPhase,
    actionHandlers,
    placementModes,
    mapFeatures,
    attackEffects,
    rewardsByEventKind,
    targetingStrategies,
    attackSelectionStrategies,
    upgradeOps,
    gameRules,
    scenarioLoadHooks,
  };
}

function resolveGameRules(
  defs: ReadonlyMap<string, GameRuleDef>,
  scenarioOverrides: Readonly<Record<string, unknown>> | undefined,
): ReadonlyMap<string, unknown> {
  const out = new Map<string, unknown>();
  for (const [key, def] of defs) out.set(key, def.default);
  if (scenarioOverrides) {
    for (const [key, value] of Object.entries(scenarioOverrides)) {
      out.set(key, value);
    }
  }
  return out;
}

export function createEngine(
  registry: ConfigRegistry,
  options: EngineOptions,
): Engine {
  const {
    systemsByPhase,
    components,
    entityKinds,
    actionHandlers,
    placementModes,
    mapFeatures,
    attackEffects,
    rewardsByEventKind,
    targetingStrategies,
    attackSelectionStrategies,
    upgradeOps,
    gameRules: gameRuleDefs,
    scenarioLoadHooks,
  } = loadPlugins(options.plugins);
  let resolvedGameRules: ReadonlyMap<string, unknown> = resolveGameRules(gameRuleDefs, undefined);
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

  const flushEvents = () => {
    if (pending.length === 0) return;
    const rewardCtx: RewardContext = {
      world,
      registry,
      tickIndex,
      emit(e: GameEvent) {
        pending.push(e);
      },
    };
    while (pending.length > 0) {
      const batch = pending;
      pending = [];
      for (const event of batch) {
        const rewards = rewardsByEventKind.get(event.kind);
        if (rewards) {
          for (const r of rewards) r.apply(rewardCtx, event);
        }
        deliver(event);
      }
    }
  };

  const deliver = (event: GameEvent) => {
    for (const h of anyHandlers) h(event);
    const kh = kindHandlers.get(event.kind);
    if (kh) for (const h of kh) h(event);
  };

  let disposed = false;
  let tickIndex = 0;
  let activeScenarioId: string | null = null;
  let tickHistory: number[] = [];
  let actionHistory: Array<[number, PlayerAction]> = [];
  const assertAlive = () => {
    if (disposed) throw new EngineDisposedError();
  };

  const buildActionContext = (): ActionContext => ({
    world,
    registry,
    scenarioId: activeScenarioId!,
    tickIndex,
    entityKinds,
    placementModes,
    mapFeatures,
    attackEffects,
    targetingStrategies,
    attackSelectionStrategies,
    upgradeOps,
    gameRules: resolvedGameRules,
    emit(event: GameEvent) {
      // Action-produced events fire synchronously, before dispatch returns (ADR-0016).
      // Queue for the post-handler flush so reward handlers run on action-emitted events.
      pending.push(event);
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
    // Record before applying so the transcript reflects the player's input as
    // submitted, regardless of action outcome (ADR-0018 transcript bundle).
    actionHistory.push([tickIndex, action]);
    const result = handler.handle(buildActionContext(), action);
    flushEvents();
    return result;
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
        entityKinds,
        placementModes,
        mapFeatures,
        attackEffects,
        targetingStrategies,
        attackSelectionStrategies,
        upgradeOps,
        gameRules: resolvedGameRules,
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
      flushEvents();
      tickHistory.push(dt);
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
      tickHistory = [];
      actionHistory = [];
      world.reset();
      const overrides = (scenario as { gameRuleOverrides?: Record<string, unknown> }).gameRuleOverrides;
      resolvedGameRules = resolveGameRules(gameRuleDefs, overrides);
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
    purchaseUpgrade(towerId: string, upgradeId: string) {
      return dispatch({ kind: "purchaseUpgrade", tower: towerId, upgrade: upgradeId });
    },
    sellTower(towerId: string) {
      return dispatch({ kind: "sellTower", tower: towerId });
    },
    overrideTargeting(towerId: string, strategy: string | TargetingStrategyConfig) {
      return dispatch({ kind: "overrideTargeting", tower: towerId, strategy });
    },
    snapshot() {
      assertAlive();
      return serializeWorld(world, tickIndex);
    },
    saveState(saveOptions?: SaveOptions): SavedState {
      assertAlive();
      if (activeScenarioId === null) {
        throw new Error("No scenario is currently active.");
      }
      const format = saveOptions?.format ?? "snapshot";
      // Build bundles with a fixed insertion order so JSON.stringify is byte-stable.
      if (format === "snapshot") {
        return {
          format: "snapshot",
          scenarioId: activeScenarioId,
          tickIndex,
          seed: options.seed,
          world: serializeWorld(world, tickIndex),
        };
      }
      return {
        format: "transcript",
        scenarioId: activeScenarioId,
        tickIndex,
        seed: options.seed,
        ticks: [...tickHistory],
        actions: [...actionHistory],
      };
    },
    loadState(bundle: SavedState): void {
      assertAlive();
      if (bundle.format === "snapshot") {
        // Mid-Scenario loadState implicitly ends the previous Scenario (ADR-0018).
        const scenario = (registry.scenarios as Record<string, unknown>)[bundle.scenarioId];
        if (!scenario) {
          throw new Error(`Unknown scenario '${bundle.scenarioId}'`);
        }
        activeScenarioId = bundle.scenarioId;
        tickIndex = bundle.tickIndex;
        pending = [];
        tickHistory = [];
        actionHistory = [];
        world.reset();
        const deserialised = deserializeWorld(bundle.world);
        for (const e of deserialised.entities) {
          world.spawn(e.id, { ...e.components });
        }
        return;
      }
      // transcript path: replay the recorded actions and tick deltas.
      this.loadScenario(bundle.scenarioId);
      let actionCursor = 0;
      const dispatchActionsAt = (tick: number): void => {
        while (
          actionCursor < bundle.actions.length &&
          bundle.actions[actionCursor]![0] === tick
        ) {
          dispatch(bundle.actions[actionCursor]![1]);
          actionCursor++;
        }
      };
      for (let i = 0; i < bundle.ticks.length; i++) {
        dispatchActionsAt(i);
        this.tick(bundle.ticks[i]!);
      }
      // Drain actions submitted at the final tickIndex (post-last-tick).
      dispatchActionsAt(bundle.tickIndex);
    },
  };
}
