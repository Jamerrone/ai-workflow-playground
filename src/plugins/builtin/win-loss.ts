import {
  PHASE_ORDER,
  Phase,
  type ActionContext,
  type Plugin,
  type Position,
} from "../../types.js";
import type { World } from "../../kernel/world.js";
import { WavesState } from "./waves.js";

declare module "../../types.js" {
  interface GameEvents {
    scenarioLost: { kind: "scenarioLost"; tick: number };
    scenarioWon: { kind: "scenarioWon"; tick: number };
  }
  interface ComponentRegistry {
    bases: { entries: Array<{ id: string; position: { x: number; y: number }; hp: number }> };
    scenarioStatus: { ended: boolean; won: boolean; lost: boolean };
  }
}

const STATE_ENTITY = "win-loss/state";

export const WinLossState = {
  entityId: STATE_ENTITY,
  readBases(world: World): ReadonlyArray<{ id: string; position: Position; hp: number }> {
    return world.get(STATE_ENTITY)?.components.get("bases")?.entries ?? [];
  },
  readStatus(world: World) {
    return world.get(STATE_ENTITY)?.components.get("scenarioStatus");
  },
};

export const winLossPlugin: Plugin = {
  id: "win-loss",
  register(api) {
    api.registerComponent({ name: "bases", writableIn: PHASE_ORDER });
    api.registerComponent({ name: "scenarioStatus", writableIn: [Phase.Rule] });
    api.registerGameRule({ key: "globalBaseHealth", default: 100 });

    api.onScenarioLoad((ctx: ActionContext) => {
      const scenarios = ctx.registry.scenarios as Record<string, { map: string }>;
      const scenario = scenarios[ctx.scenarioId];
      if (!scenario) return;
      const maps = ctx.registry.maps as Record<string, { bases: Array<{ id: string; position: { x: number; y: number } }> }>;
      const map = maps[scenario.map];
      if (!map) return;
      const baseHealth = ctx.gameRules.get("globalBaseHealth") as number;
      ctx.world.spawn(STATE_ENTITY, {
        bases: {
          entries: map.bases.map((b) => ({ id: b.id, position: b.position, hp: baseHealth })),
        },
        scenarioStatus: { ended: false, won: false, lost: false },
      });
    });

    api.registerSystem({
      id: "kernel/winLoss",
      phase: Phase.Rule,
      reads: ["bases", "waveState", "scenarioStatus", "enemy"],
      writes: ["scenarioStatus"],
      run(ctx) {
        if (!ctx.scenarioId) return;
        const stateEntity = ctx.world.get(STATE_ENTITY);
        if (!stateEntity) return;
        const status = stateEntity.components.get("scenarioStatus");
        if (!status || status.ended) return;
        const bases = stateEntity.components.get("bases");
        const wavesEntity = ctx.world.get(WavesState.entityId);
        const ws = wavesEntity?.components.get("waveState");
        if (!bases || !ws) return;

        const baseDead = bases.entries.some((b) => b.hp <= 0);
        if (baseDead) {
          ctx.world.mutate(STATE_ENTITY, "scenarioStatus", () => ({
            ended: true,
            won: false,
            lost: true,
          }));
          ctx.emit({ kind: "scenarioLost", tick: ctx.tickIndex });
          return;
        }

        const scenario = (ctx.registry.scenarios as Record<string, any>)[ctx.scenarioId];
        const allWavesSent = ws.nextIndex >= scenario.waves.length;
        const noEnemies = ctx.world.query({ all: ["enemy"] }).length === 0;
        if (allWavesSent && noEnemies && !ws.active) {
          ctx.world.mutate(STATE_ENTITY, "scenarioStatus", () => ({
            ended: true,
            won: true,
            lost: false,
          }));
          ctx.emit({ kind: "scenarioWon", tick: ctx.tickIndex });
        }
      },
    });
  },
};
