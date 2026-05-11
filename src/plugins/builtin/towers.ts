import { actionFailure } from "../../kernel/action-result.js";
import {
  PHASE_ORDER,
  Phase,
  type ActionContext,
  type PlaceTowerAction,
  type PlacementValidationResult,
  type Plugin,
  type Position,
} from "../../types.js";

interface TowerArchetype {
  readonly cost: number;
  readonly attacks: ReadonlyArray<{
    readonly id: string;
    readonly stats: { readonly range: number; readonly cooldown: number; readonly damage: number };
    readonly effects: ReadonlyArray<{ readonly kind: string; readonly stats?: { readonly amount?: number } }>;
  }>;
}

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

    // Scenario state: gold (initial value from startingGold GameRule override).
    api.onScenarioLoad((ctx: ActionContext) => {
      const scenario = (ctx.registry.scenarios as Record<string, { gameRuleOverrides?: { startingGold?: number } }>)[ctx.scenarioId];
      const startingGold = scenario?.gameRuleOverrides?.startingGold ?? 0;
      ctx.world.spawn("towers/state", { gold: { amount: startingGold } });
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

        const goldEntity = ctx.world.get("towers/state");
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
        });
        const newGold = goldComp.amount - towerDef.cost;
        ctx.world.mutate("towers/state", "gold", () => ({ amount: newGold }));
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
  },
};
