export interface ConfigRegistry {
  components: Record<string, unknown>;
  entityKinds: Record<string, unknown>;
  maps: Record<string, unknown>;
  towers: Record<string, unknown>;
  enemies: Record<string, unknown>;
  summons: Record<string, unknown>;
  waves: Record<string, unknown>;
  scenarios: Record<string, unknown>;
  upgrades: Record<string, unknown>;
  difficulties: Record<string, unknown>;
  gameRules: Record<string, unknown>;
}

export const Phase = {
  Wave: "wave",
  Simulation: "simulation",
  Effect: "effect",
  Reward: "reward",
  Rule: "rule",
  Emit: "emit",
} as const;
export type Phase = (typeof Phase)[keyof typeof Phase];

export const PHASE_ORDER: readonly Phase[] = [
  Phase.Wave,
  Phase.Simulation,
  Phase.Effect,
  Phase.Reward,
  Phase.Rule,
  Phase.Emit,
];

export interface ComponentDef {
  readonly name: string;
  readonly writableIn: readonly Phase[];
}

export interface EntityKindDef {
  readonly kind: string;
  readonly components: readonly string[];
}

export interface GameEvent {
  readonly kind: string;
  readonly tick: number;
  readonly [extra: string]: unknown;
}

export type EventHandler<E extends GameEvent = GameEvent> = (event: E) => void;

export interface Position {
  readonly x: number;
  readonly y: number;
}

export type ActionResult<TEffect = unknown> =
  | { readonly ok: true; readonly effect: TEffect }
  | {
      readonly ok: false;
      readonly code: string;
      readonly message: string;
      readonly hint?: string;
    };

export interface PlayerActionBase {
  readonly kind: string;
}

export interface PlaceTowerAction extends PlayerActionBase {
  readonly kind: "placeTower";
  readonly tower: string;
  readonly position: Position;
}

export interface SendNextWaveAction extends PlayerActionBase {
  readonly kind: "sendNextWave";
}

export interface PurchaseUpgradeAction extends PlayerActionBase {
  readonly kind: "purchaseUpgrade";
  readonly tower: string;
  readonly upgrade: string;
}

export interface SellTowerAction extends PlayerActionBase {
  readonly kind: "sellTower";
  readonly tower: string;
}

export interface OverrideTargetingAction extends PlayerActionBase {
  readonly kind: "overrideTargeting";
  readonly tower: string;
  /** Accepts either a TargetingStrategyConfig or its `kind` as a string shorthand (ADR-0015). */
  readonly strategy: string | TargetingStrategyConfig;
}

export interface MoveRallyPointAction extends PlayerActionBase {
  readonly kind: "moveRallyPoint";
  readonly tower: string;
  readonly position: Position;
}

export type PlayerAction =
  | PlaceTowerAction
  | SendNextWaveAction
  | PurchaseUpgradeAction
  | SellTowerAction
  | OverrideTargetingAction
  | MoveRallyPointAction
  | PlayerActionBase;

export interface PlacementValidationResult {
  readonly ok: boolean;
  readonly reason?: string;
  /**
   * Optional override of the default `INVALID_POSITION` failure code so a
   * PlacementMode can distinguish failure categories (e.g. `INVALID_PLACEMENT`
   * vs `SLOT_OCCUPIED`).
   */
  readonly code?: string;
}

export interface PlacementModeDef {
  readonly kind: string;
  validate(
    position: Position,
    map: unknown,
    world: import("./kernel/world.js").World,
  ): PlacementValidationResult;
}

export type MapFeatureValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

export interface MapFeatureDef {
  readonly kind: string;
  validate(feature: unknown): MapFeatureValidationResult;
}

export interface ActionContext {
  readonly world: import("./kernel/world.js").World;
  readonly registry: ConfigRegistry;
  readonly scenarioId: string;
  readonly tickIndex: number;
  readonly entityKinds: ReadonlyMap<string, EntityKindDef>;
  readonly placementModes: ReadonlyMap<string, PlacementModeDef>;
  readonly mapFeatures: ReadonlyMap<string, MapFeatureDef>;
  readonly attackEffects: ReadonlyMap<string, AttackEffectDef>;
  readonly targetingStrategies: ReadonlyMap<string, TargetingStrategyDef>;
  readonly attackSelectionStrategies: ReadonlyMap<string, AttackSelectionStrategyDef>;
  readonly upgradeOps: ReadonlyMap<string, UpgradeOpDef>;
  readonly gameRules: ReadonlyMap<string, unknown>;
  emit(event: GameEvent): void;
}

export type GameRuleValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

export interface GameRuleDef<T = unknown> {
  readonly key: string;
  readonly default: T;
  validate?(value: unknown): GameRuleValidationResult;
}

export interface TargetingStrategyConfig {
  readonly kind: string;
  readonly [extra: string]: unknown;
}

export interface TargetingCandidate {
  readonly id: string;
  readonly components: ReadonlyMap<string, unknown>;
}

export interface TargetingContext {
  readonly source: { readonly id: string; readonly position: Position };
  readonly basePosition: Position;
  readonly eligible: ReadonlyArray<TargetingCandidate>;
  readonly config: TargetingStrategyConfig;
}

export type TargetingStrategyValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

export interface TargetingStrategyDef {
  readonly kind: string;
  validate(config: unknown): TargetingStrategyValidationResult;
  select(ctx: TargetingContext): TargetingCandidate | undefined;
}

export interface AttackEffectConfig {
  readonly kind: string;
  readonly id?: string;
  readonly stats?: Readonly<Record<string, unknown>>;
  readonly [extra: string]: unknown;
}

export interface AttackEffectFire {
  readonly source: { readonly id: string; readonly position: Position };
  readonly primaryTarget: { readonly id: string; readonly position: Position };
  readonly attack: {
    readonly id: string;
    readonly stats: Readonly<Record<string, unknown>>;
    readonly targetFilter?: { readonly require?: readonly string[]; readonly exclude?: readonly string[] };
  };
  readonly effects: ReadonlyArray<AttackEffectConfig>;
}

export interface AttackEffectState {
  /** Entity ids that subsequent effects in this fire will affect. */
  targets: string[];
  /** When true, the apply loop skips all remaining effects for this fire. */
  abort: boolean;
}

export interface AttackEffectContext {
  readonly tickIndex: number;
  readonly dt: number;
  readonly world: import("./kernel/world.js").World;
  readonly registry: ConfigRegistry;
  readonly fire: AttackEffectFire;
  readonly effect: AttackEffectConfig;
  readonly state: AttackEffectState;
  emit(event: GameEvent): void;
}

export type AttackEffectValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

export interface DamagePreviewContext {
  readonly world: import("./kernel/world.js").World;
  readonly source: { readonly id: string; readonly position: Position };
  readonly primaryTarget: { readonly id: string; readonly position: Position };
  readonly attack: {
    readonly id: string;
    readonly stats: Readonly<Record<string, unknown>>;
    readonly targetFilter?: { readonly require?: readonly string[]; readonly exclude?: readonly string[] };
  };
}

export interface AttackEffectDef {
  readonly kind: string;
  validate(effect: unknown): AttackEffectValidationResult;
  apply(ctx: AttackEffectContext): void;
  /**
   * Optional: expected damage this effect would deal on a fire — consumed by the
   * `highest-damage` AttackSelectionStrategy. Returns 0 (or nothing) for effects
   * that don't deal damage (slow, target-count, projectile-count, etc.).
   */
  damagePreview?(
    stats: Readonly<Record<string, unknown>>,
    fireContext: DamagePreviewContext,
  ): number;
}

export interface AttackSelectionStrategyConfig {
  readonly kind: string;
  readonly [extra: string]: unknown;
}

export interface AttackSelectionCandidate {
  readonly id: string;
  readonly stats: Readonly<Record<string, unknown>>;
  readonly targetFilter?: { readonly require?: readonly string[]; readonly exclude?: readonly string[] };
  readonly effects: ReadonlyArray<AttackEffectConfig>;
}

export interface AttackSelectionContext {
  readonly source: { readonly id: string; readonly position: Position };
  /**
   * Pre-filtered Attacks for this attacker: off cooldown AND at least one
   * targetable enemy within range. The strategy's only remaining job is to
   * rank these and pick one.
   */
  readonly eligible: ReadonlyArray<AttackSelectionCandidate>;
  readonly config: AttackSelectionStrategyConfig;
  readonly attackEffects: ReadonlyMap<string, AttackEffectDef>;
  readonly world: import("./kernel/world.js").World;
  /** Looks up a representative in-range, filter-passing target for a given Attack. */
  resolveTarget(attack: AttackSelectionCandidate): { id: string; position: Position } | undefined;
}

export type AttackSelectionStrategyValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

export interface AttackSelectionStrategyDef {
  readonly kind: string;
  validate(config: unknown): AttackSelectionStrategyValidationResult;
  select(ctx: AttackSelectionContext): AttackSelectionCandidate | undefined;
}

export type UpgradeOpValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

export interface UpgradeOpContext {
  readonly tickIndex: number;
  readonly world: import("./kernel/world.js").World;
  readonly registry: ConfigRegistry;
  readonly tower: import("./kernel/world.js").Entity;
  readonly op: Readonly<Record<string, unknown>>;
  emit(event: GameEvent): void;
}

export interface UpgradeOpDef {
  readonly kind: string;
  validate(op: unknown): UpgradeOpValidationResult;
  apply(ctx: UpgradeOpContext): void;
}

export interface ActionHandlerDef<
  A extends PlayerAction = PlayerAction,
  E = unknown,
> {
  readonly kind: string;
  handle(ctx: ActionContext, action: A): ActionResult<E>;
}

export type ScenarioLoadHook = (ctx: ActionContext) => void;

export interface FireAttackRequest {
  readonly attacker: string;
  readonly attack: {
    readonly id: string;
    readonly stats: Readonly<Record<string, unknown>>;
    readonly effects: ReadonlyArray<AttackEffectConfig>;
    readonly targetFilter?: {
      readonly require?: readonly string[];
      readonly exclude?: readonly string[];
    };
  };
  readonly primaryTarget: string;
}

export interface SystemContext {
  readonly tickIndex: number;
  readonly dt: number;
  readonly world: import("./kernel/world.js").World;
  readonly registry: ConfigRegistry;
  readonly scenarioId: string | null;
  readonly entityKinds: ReadonlyMap<string, EntityKindDef>;
  readonly placementModes: ReadonlyMap<string, PlacementModeDef>;
  readonly mapFeatures: ReadonlyMap<string, MapFeatureDef>;
  readonly attackEffects: ReadonlyMap<string, AttackEffectDef>;
  readonly targetingStrategies: ReadonlyMap<string, TargetingStrategyDef>;
  readonly attackSelectionStrategies: ReadonlyMap<string, AttackSelectionStrategyDef>;
  readonly upgradeOps: ReadonlyMap<string, UpgradeOpDef>;
  readonly gameRules: ReadonlyMap<string, unknown>;
  emit(event: GameEvent): void;
  /**
   * Queue a fire on the unified attack pipeline. The kernel verifies the
   * attacker is off cooldown, pushes the resolved attack into `pendingFires`
   * for `attack-effects/apply` to consume next phase, and sets the attacker's
   * `cooldownTimer` to `attack.stats.cooldown`. Returns `true` iff a fire was
   * queued; `false` if the attacker is missing, on cooldown, or the target is
   * missing. The caller is responsible for the domain-specific `*Attacked`
   * event payload, since payload shapes differ across Tower / Guard / Enemy.
   */
  fireAttack(req: FireAttackRequest): boolean;
}

export interface SystemDef {
  readonly id: string;
  readonly phase: Phase;
  readonly reads: readonly string[];
  readonly writes: readonly string[];
  readonly before?: readonly string[];
  readonly after?: readonly string[];
  run(ctx: SystemContext): void;
}

export interface RewardContext {
  readonly world: import("./kernel/world.js").World;
  readonly registry: ConfigRegistry;
  readonly tickIndex: number;
  emit(event: GameEvent): void;
}

export interface RewardKindDef {
  readonly kind: string;
  readonly eventKind: string;
  apply(ctx: RewardContext, event: GameEvent): void;
}

export interface RegistrationApi {
  registerComponent(def: ComponentDef): void;
  registerEntityKind(def: EntityKindDef): void;
  registerSystem(def: SystemDef): void;
  registerActionHandler(def: ActionHandlerDef): void;
  registerPlacementMode(def: PlacementModeDef): void;
  registerMapFeature(def: MapFeatureDef): void;
  registerAttackEffect(def: AttackEffectDef): void;
  registerReward(def: RewardKindDef): void;
  registerTargetingStrategy(def: TargetingStrategyDef): void;
  registerAttackSelectionStrategy(def: AttackSelectionStrategyDef): void;
  registerUpgradeOp(def: UpgradeOpDef): void;
  registerGameRule<T = unknown>(def: GameRuleDef<T>): void;
  onScenarioLoad(hook: ScenarioLoadHook): void;
}

export interface Plugin {
  readonly id: string;
  register(api: RegistrationApi): void;
}

export interface EngineOptions {
  plugins: readonly Plugin[];
  seed: number;
}

export interface SnapshotBundle {
  readonly format: "snapshot";
  readonly scenarioId: string;
  readonly tickIndex: number;
  readonly seed: number;
  /** Canonical-JSON serialised world; same bytes as `engine.snapshot()` produces. */
  readonly world: string;
}

export interface TranscriptBundle {
  readonly format: "transcript";
  readonly scenarioId: string;
  readonly tickIndex: number;
  readonly seed: number;
  /** Per-tick dt sequence — `ticks[i]` is the dt passed to the i-th tick after loadScenario. */
  readonly ticks: readonly number[];
  /** Recorded actions indexed by the tickIndex they were dispatched at, in dispatch order. */
  readonly actions: ReadonlyArray<readonly [number, PlayerAction]>;
}

export type SavedState = SnapshotBundle | TranscriptBundle;

export interface SaveOptions {
  /** Which bundle format to produce. Default: `"snapshot"` (direct restore, ADR-0018). */
  readonly format?: "snapshot" | "transcript";
}

export interface Engine {
  tick(dt: number): void;
  dispose(): void;
  on(kind: string, handler: EventHandler): () => void;
  onEvent(handler: EventHandler): () => void;
  loadScenario(scenarioId: string): void;
  dispatch(action: PlayerAction): ActionResult;
  placeTower(towerId: string, position: Position): ActionResult;
  sendNextWave(): ActionResult;
  purchaseUpgrade(towerId: string, upgradeId: string): ActionResult;
  sellTower(towerId: string): ActionResult;
  overrideTargeting(
    towerId: string,
    strategy: string | TargetingStrategyConfig,
  ): ActionResult;
  snapshot(): string;
  saveState(options?: SaveOptions): SavedState;
  loadState(bundle: SavedState): void;
}
