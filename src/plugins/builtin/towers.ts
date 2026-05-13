import { actionFailure } from "../../kernel/action-result.js";
import {
  PHASE_ORDER,
  Phase,
  type ActionContext,
  type GameEvent,
  type PlaceTowerAction,
  type PlacementValidationResult,
  type Plugin,
  type Position,
  type RewardContext,
  type SellTowerAction,
} from "../../types.js";

interface TowerArchetype {
  readonly cost: number;
  readonly attacks: ReadonlyArray<{
    readonly id: string;
    readonly stats: { readonly range: number; readonly cooldown: number; readonly damage: number };
    readonly effects: ReadonlyArray<{ readonly kind: string; readonly stats?: { readonly amount?: number } }>;
  }>;
}

interface UpgradeArchetype {
  readonly cost?: number;
}

interface ScenarioGameRules {
  readonly defaultSellRefundPercent?: number;
}

const DEFAULT_SELL_REFUND_PERCENT = 0.7;
const TOWERS_STATE_ENTITY = "towers/state";

interface MapData {
  readonly placementMode: { readonly kind: string };
  readonly towerSlots?: ReadonlyArray<Position>;
}

export const towersPlugin: Plugin = {
  id: "towers",
  register(api) {
    // Components owned by the towers plugin.
    api.registerComponent({ name: "tower", writableIn: PHASE_ORDER });
    api.registerComponent({ name: "position", writableIn: PHASE_ORDER });
    api.registerComponent({ name: "cooldownTimer", writableIn: [Phase.Simulation] });
    api.registerComponent({ name: "gold", writableIn: [Phase.Reward] });
    api.registerComponent({ name: "attacks", writableIn: PHASE_ORDER });
    api.registerComponent({ name: "purchasedUpgrades", writableIn: PHASE_ORDER });
    // soldTowers tracks ids of sold towers so a second sellTower on the same id
    // reports TOWER_ALREADY_SOLD rather than the more generic UNKNOWN_TOWER.
    api.registerComponent({ name: "soldTowers", writableIn: PHASE_ORDER });

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
      const scenario = (ctx.registry.scenarios as Record<string, { gameRuleOverrides?: { startingGold?: number } }>)[ctx.scenarioId];
      const startingGold = scenario?.gameRuleOverrides?.startingGold ?? 0;
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
          return actionFailure("INVALID_POSITION", valid.reason ?? "Invalid placement position.");
        }

        const goldEntity = ctx.world.get(TOWERS_STATE_ENTITY);
        const goldComp = goldEntity?.components.get("gold") as { amount: number } | undefined;
        if (!goldComp || goldComp.amount < towerDef.cost) {
          return actionFailure("INSUFFICIENT_GOLD", "Not enough gold to place tower.");
        }

        // Validation complete — apply.
        const entityId = `tower:${a.tower}:${a.position.x},${a.position.y}`;
        ctx.world.spawn(entityId, {
          tower: { archetype: a.tower },
          position: { x: a.position.x, y: a.position.y },
          cooldownTimer: { remaining: 0 },
          attacks: structuredClone(towerDef.attacks),
          purchasedUpgrades: [] as string[],
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
        const soldComp = stateEntity?.components.get("soldTowers") as { ids: string[] } | undefined;
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
        const archetypeId = (towerEntity.components.get("tower") as { archetype: string }).archetype;
        const archetype = (ctx.registry.towers as Record<string, TowerArchetype>)[archetypeId];
        if (!archetype) {
          return actionFailure(
            "UNKNOWN_TOWER",
            `Tower archetype '${archetypeId}' is not registered.`,
          );
        }
        const purchased =
          (towerEntity.components.get("purchasedUpgrades") as string[] | undefined) ?? [];
        const upgrades = ctx.registry.upgrades as Record<string, UpgradeArchetype | undefined>;
        const upgradeCosts = purchased.reduce(
          (sum, id) => sum + (upgrades[id]?.cost ?? 0),
          0,
        );
        const scenario = (ctx.registry.scenarios as Record<string, { gameRuleOverrides?: ScenarioGameRules }>)[ctx.scenarioId];
        const refundPercent =
          scenario?.gameRuleOverrides?.defaultSellRefundPercent ?? DEFAULT_SELL_REFUND_PERCENT;
        // Nudge by a tiny epsilon so float-noise products like 90 * 0.7 = 62.9999…
        // don't floor down a whole gold piece below the documented refund.
        const refund = Math.floor((archetype.cost + upgradeCosts) * refundPercent + 1e-9);

        // Validation complete — apply.
        const position = towerEntity.components.get("position") as Position | undefined;
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
        const goldComp = stateEntity?.components.get("gold") as { amount: number } | undefined;
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
