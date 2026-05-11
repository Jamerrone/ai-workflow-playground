import { actionFailure } from "../../kernel/action-result.js";
import {
  PHASE_ORDER,
  Phase,
  type ActionContext,
  type Plugin,
} from "../../types.js";

interface WaveState {
  nextIndex: number;
  active: boolean;
  timeInWave: number;
  sentByGroup: Record<string, number>;
}

const STATE_ENTITY = "waves/state";

export const wavesPlugin: Plugin = {
  id: "waves",
  register(api) {
    // Components owned by the waves plugin.
    api.registerComponent({ name: "enemy", writableIn: PHASE_ORDER });
    api.registerComponent({ name: "health", writableIn: [Phase.Effect, Phase.Wave] });
    api.registerComponent({ name: "pathProgress", writableIn: [Phase.Simulation, Phase.Wave] });
    api.registerComponent({ name: "waveState", writableIn: PHASE_ORDER });

    api.onScenarioLoad((ctx: ActionContext) => {
      ctx.world.spawn(STATE_ENTITY, {
        waveState: {
          nextIndex: 0,
          active: false,
          timeInWave: 0,
          sentByGroup: {} as Record<string, number>,
        },
      });
    });

    // sendNextWave PlayerAction handler. The manual WaveTrigger advances only on this action.
    api.registerActionHandler({
      kind: "sendNextWave",
      handle(ctx) {
        const scenario = (ctx.registry.scenarios as Record<string, { waves: Array<unknown> }>)[ctx.scenarioId];
        if (!scenario) return actionFailure("NO_SCENARIO_LOADED", "Active scenario not found in registry.");
        const wsEntity = ctx.world.get(STATE_ENTITY);
        const ws = wsEntity?.components.get("waveState") as WaveState | undefined;
        if (!ws) return actionFailure("NO_SCENARIO_LOADED", "Wave state missing.");
        if (ws.active) return actionFailure("WAVE_ALREADY_ACTIVE", "Current wave still spawning.");
        if (ws.nextIndex >= scenario.waves.length) {
          return actionFailure("NO_WAVES", "No more waves to send.");
        }
        ctx.world.mutate(STATE_ENTITY, "waveState", () => ({
          ...ws,
          active: true,
          timeInWave: 0,
          sentByGroup: {},
        }));
        ctx.emit({
          kind: "waveStarted",
          tick: ctx.tickIndex,
          waveIndex: ws.nextIndex,
        });
        return { ok: true, effect: { waveIndex: ws.nextIndex } };
      },
    });

    api.registerSystem({
      id: "waves/spawn",
      phase: Phase.Wave,
      reads: [],
      writes: ["waveState", "enemy", "position", "health", "pathProgress"],
      run(ctx) {
        if (!ctx.scenarioId) return;
        const game = ctx.world.get(STATE_ENTITY);
        if (!game) return;
        const ws = game.components.get("waveState") as WaveState | undefined;
        if (!ws || !ws.active) return;

        const scenario = (ctx.registry.scenarios as Record<string, any>)[ctx.scenarioId];
        const map = (ctx.registry.maps as Record<string, any>)[scenario.map];
        const waveRef = scenario.waves[ws.nextIndex];
        const wave = (ctx.registry.waves as Record<string, any>)[waveRef.id];

        const advanced = ws.timeInWave + ctx.dt;
        const newSent: Record<string, number> = { ...ws.sentByGroup };
        let totalSpawned = 0;
        let totalRequired = 0;

        for (const group of wave.groups as Array<any>) {
          totalRequired += group.count as number;
          const already = newSent[group.id] ?? 0;
          const sinceDelay = advanced - (group.delay ?? 0);
          if (sinceDelay < 0) {
            totalSpawned += already;
            continue;
          }
          const interval = group.interval ?? 0;
          const shouldHave =
            interval === 0
              ? group.count
              : Math.min(group.count, Math.floor(sinceDelay / interval) + 1);
          for (let i = already; i < shouldHave; i++) {
            const pathId = waveRef.pathBindings[group.id] as string;
            const path = (map.paths as Array<any>).find((p) => p.id === pathId);
            const enemyDef = (ctx.registry.enemies as Record<string, any>)[group.enemy];
            const spawnAt = path.waypoints[0];
            const enemyId = `enemy:${group.id}:${i}:${ctx.tickIndex}`;
            ctx.world.spawn(enemyId, {
              enemy: { archetype: group.enemy, killReward: enemyDef.killReward },
              position: { x: spawnAt.x, y: spawnAt.y },
              health: { hp: enemyDef.stats.hp },
              pathProgress: {
                pathId,
                wpIndex: 0,
                speed: enemyDef.stats.speed,
                baseDamage: enemyDef.stats.baseDamage,
              },
            });
          }
          newSent[group.id] = shouldHave;
          totalSpawned += shouldHave;
        }

        ctx.world.mutate(STATE_ENTITY, "waveState", () => ({
          ...ws,
          timeInWave: advanced,
          sentByGroup: newSent,
        }));

        if (totalSpawned >= totalRequired) {
          const remaining = ctx.world.query({ all: ["enemy"] });
          if (remaining.length === 0) {
            ctx.world.mutate(STATE_ENTITY, "waveState", (v) => {
              const cur = v as WaveState;
              return { ...cur, active: false, nextIndex: cur.nextIndex + 1 };
            });
          }
        }
      },
    });
  },
};
