import { actionFailure } from "../../kernel/action-result.js";
import {
  PHASE_ORDER,
  Phase,
  type ActionContext,
  type AttackEffectConfig,
  type GameEvent,
  type OverrideTargetingAction,
  type PlaceTowerAction,
  type PlacementValidationResult,
  type Plugin,
  type Position,
  type RewardContext,
  type SellTowerAction,
  type TargetingStrategyConfig,
} from "../../types.js";
import {
  checkKind,
  requireArray,
  requireNumber,
  validateAttackEffectFields,
} from "../../loader/validator-helpers.js";
import { isObject } from "../../loader/normalize.js";
import type { BucketValidatorContext } from "../../loader/types.js";

declare module "../../types.js" {
  interface GameEvents {
    towerPlaced: { kind: "towerPlaced"; tick: number; tower: string; archetype: string; position: Position };
    towerSold: { kind: "towerSold"; tick: number; tower: string; archetype: string; position: Position | undefined; refund: number };
    targetingOverridden: { kind: "targetingOverridden"; tick: number; tower: string; strategy: TargetingStrategyConfig };
  }
}

// AttackEffect kinds that the built-in attack-effects plugin ships with a
// `damagePreview`. Used by the towers validator to warn when a Tower opts into
// `highest-damage` attack selection while mounting effects whose registered
// AttackEffectDef lacks the damagePreview hook.
const BUILTIN_DAMAGE_PREVIEW_KINDS: ReadonlySet<string> = new Set([
  "damage",
  "splash",
  "pierce",
  "line-pierce",
  "bounce",
  "dot",
]);

function validateTowers(ctx: BucketValidatorContext): void {
  const raw = ctx.entry;
  const id = ctx.id;
  const path = ctx.path;
  requireNumber(ctx, raw, "cost", path);
  requireArray(ctx, raw, "attacks", path);
  const isHighestDamage =
    isObject(raw.attackSelection) && raw.attackSelection.kind === "highest-damage";
  const damagePreviewKinds = new Set<string>([
    ...BUILTIN_DAMAGE_PREVIEW_KINDS,
    ...(ctx.options.damagePreviewKinds ?? []),
  ]);
  if (Array.isArray(raw.attacks)) {
    const seenIds = new Set<string>();
    raw.attacks.forEach((atk, i) => {
      if (!isObject(atk)) return;
      const atkPath = `${path}.attacks[${i}]`;
      const atkId = typeof atk.id === "string" ? atk.id : undefined;
      if (atkId === undefined) {
        ctx.addError({
          severity: "error",
          code: "INVALID_FIELD",
          path: `${atkPath}.id`,
          message: `Attack missing 'id'.`,
          expected: "string",
          actual: typeof atk.id,
        });
      } else if (seenIds.has(atkId)) {
        ctx.addError({
          severity: "error",
          code: "INVALID_FIELD",
          path: `${atkPath}.id`,
          message: `Duplicate Attack id '${atkId}' on tower '${id}'.`,
        });
      } else {
        seenIds.add(atkId);
      }
      if (Array.isArray(atk.effects)) {
        atk.effects.forEach((eff, j) => {
          if (!isObject(eff)) return;
          const effPath = `${atkPath}.effects[${j}]`;
          checkKind(ctx, "attackEffect", eff, effPath);
          validateAttackEffectFields(ctx, eff, effPath);
          if (
            isHighestDamage &&
            typeof eff.kind === "string" &&
            !damagePreviewKinds.has(eff.kind)
          ) {
            ctx.addWarning({
              severity: "warning",
              code: "DAMAGE_PREVIEW_MISSING",
              path: `${effPath}.kind`,
              message: `Tower '${id}' uses attackSelection 'highest-damage' but Attack '${atkId ?? `[${i}]`}' mounts an effect of kind '${eff.kind}' whose AttackEffectDef does not implement 'damagePreview'.`,
              expected: "effect kind with a registered damagePreview",
              actual: eff.kind,
              hint: "Either implement damagePreview on the registering plugin, switch to 'declaration-order' attack selection, or remove the effect.",
            });
          }
        });
      }
    });
  }
  if (raw.targeting !== undefined && isObject(raw.targeting)) {
    checkKind(ctx, "targeting", raw.targeting, `${path}.targeting`);
  }
  if (raw.attackSelection !== undefined && isObject(raw.attackSelection)) {
    checkKind(ctx, "attackSelection", raw.attackSelection, `${path}.attackSelection`);
  }
}

interface TowerArchetype {
  readonly cost: number;
  readonly targeting?: TargetingStrategyConfig;
  readonly strategy?: TargetingStrategyConfig;
  readonly attacks: ReadonlyArray<{
    readonly id: string;
    readonly stats: { readonly range: number; readonly cooldown: number };
    readonly effects: ReadonlyArray<{ readonly kind: string; readonly stats?: { readonly amount?: number } }>;
  }>;
  /**
   * Optional plugin-contributed Components attached to the entity on placement.
   * Lets any plugin extend Tower entities through JSON without engine changes
   * (e.g. guards plugin's `summon` Component on Barracks-style Towers).
   */
  readonly components?: Readonly<Record<string, unknown>>;
}

interface UpgradeArchetype {
  readonly cost?: number;
}

const DEFAULT_SELL_REFUND_PERCENT = 0.7;
const TOWERS_STATE_ENTITY = "towers/state";

interface MapData {
  readonly placementMode: { readonly kind: string };
  readonly towerSlots?: ReadonlyArray<Position>;
}

declare module "../../types.js" {
  interface ComponentRegistry {
    tower: { archetype: string };
    position: { x: number; y: number };
    cooldownTimer: { remaining: number };
    gold: { amount: number };
    attacks: ReadonlyArray<{
      readonly id: string;
      readonly stats: { readonly range: number; readonly cooldown: number; readonly [key: string]: number };
      readonly effects: ReadonlyArray<AttackEffectConfig>;
      readonly targetFilter?: { readonly require?: readonly string[]; readonly exclude?: readonly string[] };
    }>;
    purchasedUpgrades: string[];
    targeting: TargetingStrategyConfig;
    soldTowers: { ids: string[] };
  }
}

export const towersPlugin: Plugin = {
  id: "towers",
  register(api) {
    // Tower JSON bucket validator — required fields, attack uniqueness, and
    // built-in AttackEffect stat requirements.
    api.registerBucketValidator({ bucket: "towers", validate: validateTowers });

    // Components owned by the towers plugin.
    api.registerComponent({ name: "tower", writableIn: PHASE_ORDER });
    api.registerComponent({ name: "position", writableIn: PHASE_ORDER });
    api.registerComponent({ name: "cooldownTimer", writableIn: [Phase.Simulation] });
    api.registerComponent({ name: "gold", writableIn: [Phase.Reward] });
    api.registerComponent({ name: "attacks", writableIn: PHASE_ORDER });
    api.registerComponent({ name: "purchasedUpgrades", writableIn: PHASE_ORDER });
    api.registerComponent({ name: "targeting", writableIn: PHASE_ORDER });
    // soldTowers tracks ids of sold towers so a second sellTower on the same id
    // reports TOWER_ALREADY_SOLD rather than the more generic UNKNOWN_TOWER.
    api.registerComponent({ name: "soldTowers", writableIn: PHASE_ORDER });

    api.registerEntityKind({
      kind: "tower",
      components: [
        "tower",
        "position",
        "cooldownTimer",
        "attacks",
        "purchasedUpgrades",
        "targeting",
      ],
    });

    api.registerGameRule({ key: "startingGold", default: 0 });
    api.registerGameRule({
      key: "defaultSellRefundPercent",
      default: DEFAULT_SELL_REFUND_PERCENT,
    });

    // Built-in PlacementMode: fixed. Placement is legal only on a pre-declared TowerSlot.
    api.registerPlacementMode({
      kind: "fixed",
      validate(position: Position, map: unknown): PlacementValidationResult {
        const slots = (map as MapData).towerSlots ?? [];
        const hit = slots.some((s) => s.x === position.x && s.y === position.y);
        return hit
          ? { ok: true }
          : { ok: false, reason: `(${position.x},${position.y}) is not a declared tower slot.` };
      },
    });

    // Scenario state: gold (initial value from startingGold GameRule override)
    // and the set of sold tower ids.
    api.onScenarioLoad((ctx: ActionContext) => {
      const startingGold = ctx.gameRules.get("startingGold") as number;
      ctx.world.spawn(TOWERS_STATE_ENTITY, {
        gold: { amount: startingGold },
        soldTowers: { ids: [] as string[] },
      });
    });

    // placeTower handler.
    api.registerActionHandler({
      kind: "placeTower",
      handle(ctx, action) {
        const a = action as PlaceTowerAction;
        const scenario = (ctx.registry.scenarios as Record<string, { map: string }>)[ctx.scenarioId];
        if (!scenario) return actionFailure("NO_SCENARIO_LOADED", "Active scenario not found in registry.");
        const towerDef = (ctx.registry.towers as Record<string, TowerArchetype>)[a.tower];
        if (!towerDef) {
          return actionFailure("NO_SUCH_TOWER", `Tower archetype '${a.tower}' is not registered.`);
        }
        const map = (ctx.registry.maps as Record<string, MapData>)[scenario.map];
        if (!map) {
          return actionFailure("NO_SUCH_MAP", `Map '${scenario.map}' is not registered.`);
        }
        const modeKind = map.placementMode.kind;
        const modeEntry = ctx.placementModes.get(modeKind);
        if (!modeEntry) {
          return actionFailure(
            "UNKNOWN_PLACEMENT_MODE",
            `No PlacementMode registered for kind '${modeKind}'.`,
          );
        }
        const valid = modeEntry.validate(a.position, map, ctx.world);
        if (!valid.ok) {
          return actionFailure(
            valid.code ?? "INVALID_POSITION",
            valid.reason ?? "Invalid placement position.",
          );
        }

        const goldEntity = ctx.world.get(TOWERS_STATE_ENTITY);
        const goldComp = goldEntity?.components.get("gold");
        if (!goldComp || goldComp.amount < towerDef.cost) {
          return actionFailure("INSUFFICIENT_GOLD", "Not enough gold to place tower.");
        }

        // Validation complete — apply.
        const entityId = `tower:${a.tower}:${a.position.x},${a.position.y}`;
        const initialTargeting: TargetingStrategyConfig =
          towerDef.targeting ?? towerDef.strategy ?? { kind: "closest-to-base" };
        ctx.world.spawn(entityId, {
          tower: { archetype: a.tower },
          position: { x: a.position.x, y: a.position.y },
          cooldownTimer: { remaining: 0 },
          attacks: structuredClone(towerDef.attacks),
          purchasedUpgrades: [] as string[],
          targeting: { ...initialTargeting },
          ...(towerDef.components
            ? (structuredClone(towerDef.components) as Record<string, unknown>)
            : {}),
        });
        const newGold = goldComp.amount - towerDef.cost;
        ctx.world.mutate(TOWERS_STATE_ENTITY, "gold", () => ({ amount: newGold }));
        ctx.emit({
          kind: "towerPlaced",
          tick: ctx.tickIndex,
          tower: entityId,
          archetype: a.tower,
          position: { ...a.position },
        });
        ctx.emit({
          kind: "goldChanged",
          tick: ctx.tickIndex,
          delta: -towerDef.cost,
          amount: newGold,
        });
        return { ok: true, effect: { entityId, gold: newGold } };
      },
    });

    // sellTower handler. Computes refund = floor((towerCost + Σ upgradeCosts) × refundPercent)
    // and emits `towerSold` carrying that refund; the sell-value RewardKind below credits gold.
    api.registerActionHandler({
      kind: "sellTower",
      handle(ctx, action) {
        const a = action as SellTowerAction;
        const stateEntity = ctx.world.get(TOWERS_STATE_ENTITY);
        const soldComp = stateEntity?.components.get("soldTowers");
        if (soldComp && soldComp.ids.includes(a.tower)) {
          return actionFailure(
            "TOWER_ALREADY_SOLD",
            `Tower '${a.tower}' has already been sold.`,
          );
        }
        const towerEntity = ctx.world.get(a.tower);
        if (!towerEntity || !towerEntity.components.has("tower")) {
          return actionFailure("UNKNOWN_TOWER", `Tower entity '${a.tower}' not found.`);
        }
        const archetypeId = towerEntity.components.get("tower")!.archetype;
        const archetype = (ctx.registry.towers as Record<string, TowerArchetype>)[archetypeId];
        if (!archetype) {
          return actionFailure(
            "UNKNOWN_TOWER",
            `Tower archetype '${archetypeId}' is not registered.`,
          );
        }
        const purchased = towerEntity.components.get("purchasedUpgrades") ?? [];
        const upgrades = ctx.registry.upgrades as Record<string, UpgradeArchetype | undefined>;
        const upgradeCosts = purchased.reduce(
          (sum, id) => sum + (upgrades[id]?.cost ?? 0),
          0,
        );
        const refundPercent = ctx.gameRules.get("defaultSellRefundPercent") as number;
        // Nudge by a tiny epsilon so float-noise products like 90 * 0.7 = 62.9999…
        // don't floor down a whole gold piece below the documented refund.
        const refund = Math.floor((archetype.cost + upgradeCosts) * refundPercent + 1e-9);

        // Validation complete — apply.
        const position = towerEntity.components.get("position");
        ctx.world.destroy(a.tower);
        const newSoldIds = [...(soldComp?.ids ?? []), a.tower];
        ctx.world.mutate(TOWERS_STATE_ENTITY, "soldTowers", () => ({ ids: newSoldIds }));
        ctx.emit({
          kind: "towerSold",
          tick: ctx.tickIndex,
          tower: a.tower,
          archetype: archetypeId,
          position: position ? { ...position } : undefined,
          refund,
        });
        return { ok: true, effect: { tower: a.tower, refund } };
      },
    });

    // overrideTargeting handler — player-driven runtime change to a Tower's
    // TargetingStrategy. Accepts a TargetingStrategyConfig or its `kind` string
    // shorthand (ADR-0015).
    api.registerActionHandler({
      kind: "overrideTargeting",
      handle(ctx, action) {
        const a = action as OverrideTargetingAction;
        const towerEntity = ctx.world.get(a.tower);
        if (!towerEntity || !towerEntity.components.has("tower")) {
          return actionFailure("UNKNOWN_TOWER", `Tower entity '${a.tower}' not found.`);
        }
        const config: TargetingStrategyConfig =
          typeof a.strategy === "string" ? { kind: a.strategy } : a.strategy;
        if (typeof config?.kind !== "string") {
          return actionFailure(
            "UNKNOWN_STRATEGY",
            `Invalid TargetingStrategy config; expected { kind: string } or a string shorthand.`,
          );
        }
        const strategyDef = ctx.targetingStrategies.get(config.kind);
        if (!strategyDef) {
          return actionFailure(
            "UNKNOWN_STRATEGY",
            `No TargetingStrategy registered for kind '${config.kind}'.`,
          );
        }
        const validation = strategyDef.validate(config);
        if (!validation.ok) {
          return actionFailure(
            "UNKNOWN_STRATEGY",
            `TargetingStrategy '${config.kind}' rejected the config: ${validation.reason}.`,
          );
        }
        ctx.world.mutate(a.tower, "targeting", () => ({ ...config }));
        ctx.emit({
          kind: "targetingOverridden",
          tick: ctx.tickIndex,
          tower: a.tower,
          strategy: { ...config },
        });
        return { ok: true, effect: { tower: a.tower, strategy: { ...config } } };
      },
    });

    // sell-value RewardKind: credits the `refund` carried on a `towerSold` event back to gold.
    // Keeping the credit in a reward (rather than inline in the action handler) lets balance-mod
    // plugins replace the refund-crediting policy without rewriting the action.
    api.registerReward({
      kind: "sell-value",
      eventKind: "towerSold",
      apply(ctx: RewardContext, event: GameEvent) {
        const refund = (event as { refund?: number }).refund;
        if (typeof refund !== "number" || refund === 0) return;
        const stateEntity = ctx.world.get(TOWERS_STATE_ENTITY);
        const goldComp = stateEntity?.components.get("gold");
        if (!goldComp) return;
        const newAmount = goldComp.amount + refund;
        ctx.world.mutate(TOWERS_STATE_ENTITY, "gold", () => ({ amount: newAmount }));
        ctx.emit({
          kind: "goldChanged",
          tick: ctx.tickIndex,
          delta: refund,
          amount: newAmount,
        });
      },
    });
  },
};
