export interface ConfigRegistry {
  components: Record<string, unknown>;
  entityKinds: Record<string, unknown>;
  maps: Record<string, unknown>;
  towers: Record<string, unknown>;
  enemies: Record<string, unknown>;
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

export type PlayerAction =
  | PlaceTowerAction
  | SendNextWaveAction
  | PurchaseUpgradeAction
  | PlayerActionBase;

export interface PlacementValidationResult {
  readonly ok: boolean;
  readonly reason?: string;
}

export interface PlacementModeDef {
  readonly kind: string;
  validate(
    position: Position,
    map: unknown,
    world: import("./kernel/world.js").World,
  ): PlacementValidationResult;
}

export interface ActionContext {
  readonly world: import("./kernel/world.js").World;
  readonly registry: ConfigRegistry;
  readonly scenarioId: string;
  readonly tickIndex: number;
  readonly placementModes: ReadonlyMap<string, PlacementModeDef>;
  readonly attackEffects: ReadonlyMap<string, AttackEffectDef>;
  readonly targetingStrategies: ReadonlyMap<string, TargetingStrategyDef>;
  readonly upgradeOps: ReadonlyMap<string, UpgradeOpDef>;
  emit(event: GameEvent): void;
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

export interface AttackEffectDef {
  readonly kind: string;
  validate(effect: unknown): AttackEffectValidationResult;
  apply(ctx: AttackEffectContext): void;
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

export interface SystemContext {
  readonly tickIndex: number;
  readonly dt: number;
  readonly world: import("./kernel/world.js").World;
  readonly registry: ConfigRegistry;
  readonly scenarioId: string | null;
  readonly placementModes: ReadonlyMap<string, PlacementModeDef>;
  readonly attackEffects: ReadonlyMap<string, AttackEffectDef>;
  readonly targetingStrategies: ReadonlyMap<string, TargetingStrategyDef>;
  readonly upgradeOps: ReadonlyMap<string, UpgradeOpDef>;
  emit(event: GameEvent): void;
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

export interface RegistrationApi {
  registerComponent(def: ComponentDef): void;
  registerSystem(def: SystemDef): void;
  registerActionHandler(def: ActionHandlerDef): void;
  registerPlacementMode(def: PlacementModeDef): void;
  registerAttackEffect(def: AttackEffectDef): void;
  registerTargetingStrategy(def: TargetingStrategyDef): void;
  registerUpgradeOp(def: UpgradeOpDef): void;
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
  snapshot(): string;
}
