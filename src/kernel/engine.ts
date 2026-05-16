import { actionFailure } from "./action-result.js";
import { EngineDisposedError } from "./errors.js";
import { withTickMath } from "./math-proxy.js";
import { resolveSystemOrder } from "./ordering.js";
import { deserializeWorld, serializeWorld } from "./snapshot.js";
import { WorldImpl } from "./world.js";
import {
  PHASE_ORDER,
  type ActionContext,
  type ActionHandlerDef,
  type ActionResult,
  type AttackEffectConfig,
  type AttackEffectDef,
  type AttackSelectionStrategyDef,
  type ComponentDef,
  type ConfigRegistry,
  type Engine,
  type EntityKindDef,
  type EngineOptions,
  type EventHandler,
  type FireAttackRequest,
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

// Convention: the attack-effects plugin owns the `pendingFires` queue Component
// on entity `attack-effects/pending`. The kernel writes to that Component via
// `ctx.fireAttack` so plugins do not need to cross-import a firing helper.
const PENDING_FIRES_ENTITY = "attack-effects/pending";
const PENDING_FIRES_COMPONENT = "pendingFires";
const COOLDOWN_TIMER_COMPONENT = "cooldownTimer";

interface QueuedFire {
  source: { id: string; position: Position };
  primaryTarget: { id: string; position: Position };
  attack: {
    id: string;
    stats: Record<string, unknown>;
    targetFilter?: { require?: readonly string[]; exclude?: readonly string[] };
  };
  effects: ReadonlyArray<AttackEffectConfig>;
}

interface RegistrationWarning {
  registry: string;
  replacedKind: string;
  replacedBy: string;
  previousPlugin: string;
}

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
  registrationWarnings: RegistrationWarning[];
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
  const registrationWarnings: RegistrationWarning[] = [];

  // Tracks which plugin last registered each "registry:kind" key.
  const ownersByKey = new Map<string, string>();
  let currentPluginId = "";

  function trackReg(registry: string, kind: string): void {
    const key = `${registry}:${kind}`;
    const prev = ownersByKey.get(key);
    if (prev !== undefined) {
      registrationWarnings.push({
        registry,
        replacedKind: kind,
        replacedBy: currentPluginId,
        previousPlugin: prev,
      });
    }
    ownersByKey.set(key, currentPluginId);
  }

  const api: RegistrationApi = {
    registerComponent(def) {
      trackReg("components", def.name);
      components.set(def.name, def);
    },
    registerEntityKind(def) {
      trackReg("entityKinds", def.kind);
      entityKinds.set(def.kind, def);
    },
    registerSystem(def) {
      systemsByPhase.get(def.phase)!.push(def);
    },
    registerActionHandler(def) {
      trackReg("actionHandlers", def.kind);
      actionHandlers.set(def.kind, def);
    },
    registerPlacementMode(def) {
      trackReg("placementModes", def.kind);
      placementModes.set(def.kind, def);
    },
    registerMapFeature(def) {
      trackReg("mapFeatures", def.kind);
      mapFeatures.set(def.kind, def);
    },
    registerAttackEffect(def) {
      trackReg("attackEffects", def.kind);
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
      trackReg("targetingStrategies", def.kind);
      targetingStrategies.set(def.kind, def);
    },
    registerAttackSelectionStrategy(def) {
      trackReg("attackSelectionStrategies", def.kind);
      attackSelectionStrategies.set(def.kind, def);
    },
    registerUpgradeOp(def) {
      trackReg("upgradeOps", def.kind);
      upgradeOps.set(def.kind, def);
    },
    registerGameRule(def) {
      trackReg("gameRules", def.key);
      gameRules.set(def.key, def as GameRuleDef);
    },
    // Bucket validators are Loader-only — the running Engine doesn't consume
    // them. Accepted here so the RegistrationApi surface is uniform across the
    // engine and the Loader's `collectBucketValidators` pass.
    registerBucketValidator() {},
    onScenarioLoad(hook) {
      scenarioLoadHooks.push(hook);
    },
  };
  for (const plugin of plugins) {
    currentPluginId = plugin.id;
    plugin.register(api);
  }

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
    registrationWarnings,
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
    registrationWarnings,
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
      const fireAttack = (req: FireAttackRequest): boolean => {
        const attacker = world.get(req.attacker);
        if (!attacker) return false;
        const cd = attacker.components.get(COOLDOWN_TIMER_COMPONENT) as
          | { remaining: number }
          | undefined;
        if (cd && cd.remaining > 0) return false;
        const target = world.get(req.primaryTarget);
        if (!target) return false;
        const attackerPos = attacker.components.get("position") as Position | undefined;
        const targetPos = target.components.get("position") as Position | undefined;
        if (!attackerPos || !targetPos) return false;
        const pendingState = world.get(PENDING_FIRES_ENTITY);
        if (!pendingState) return false;
        const existing =
          (pendingState.components.get(PENDING_FIRES_COMPONENT) as
            | { queue: QueuedFire[] }
            | undefined)?.queue ?? [];
        const fire: QueuedFire = {
          source: { id: req.attacker, position: { ...attackerPos } },
          primaryTarget: { id: req.primaryTarget, position: { ...targetPos } },
          attack: {
            id: req.attack.id,
            stats: { ...req.attack.stats },
            ...(req.attack.targetFilter !== undefined
              ? { targetFilter: req.attack.targetFilter }
              : {}),
          },
          effects: req.attack.effects,
        };
        world.mutate(PENDING_FIRES_ENTITY, PENDING_FIRES_COMPONENT, () => ({
          queue: [...existing, fire],
        }));
        const cooldown = (req.attack.stats as { cooldown?: number }).cooldown ?? 0;
        // Always write cooldownTimer so first-time attackers (e.g. Enemies whose
        // archetype declared `attacks` without a prior cooldownTimer init) get
        // their cooldown started.
        world.mutate(req.attacker, COOLDOWN_TIMER_COMPONENT, () => ({
          remaining: cooldown,
        }));
        return true;
      };
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
        fireAttack,
      };
      for (const phase of PHASE_ORDER) {
        world.setPhase(phase);
        for (const system of systemsByPhase.get(phase)!) {
          withTickMath(system.id, () => system.run(ctx));
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
      // Push REGISTRY_REPLACEMENT warnings so they are delivered on the first
      // tick or dispatch after loadScenario. Observable via engine.onEvent.
      for (const w of registrationWarnings) {
        pending.push({
          kind: "REGISTRY_REPLACEMENT",
          tick: 0,
          registry: w.registry,
          replacedKind: w.replacedKind,
          replacedBy: w.replacedBy,
          previousPlugin: w.previousPlugin,
        });
      }
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
