import { actionFailure } from "../../kernel/action-result.js";
import {
  PHASE_ORDER,
  Phase,
  type ActionContext,
  type GameEvent,
  type Plugin,
  type RewardContext,
} from "../../types.js";

interface WaveState {
  nextIndex: number;
  active: boolean;
  timeInWave: number;
  sentByGroup: Record<string, number>;
  // Seconds remaining before the next auto/hybrid Wave activates. `null` means
  // no cooldown is currently in flight — either the Scenario is manual-triggered,
  // or there are no more Waves to start.
  cooldownRemaining: number | null;
}

const STATE_ENTITY = "waves/state";
const GOLD_ENTITY = "towers/state";

interface MapPath {
  readonly id: string;
  readonly kind?: string;
  readonly waypoints: ReadonlyArray<{ readonly x: number; readonly y: number }>;
}

interface MapData {
  readonly paths: ReadonlyArray<MapPath>;
}

interface ScenarioWaveRef {
  readonly id: string;
  readonly pathBindings?: unknown;
}

interface WaveTriggerConfig {
  readonly kind: string;
  readonly cooldown?: number;
}

interface ScenarioData {
  readonly map: string;
  readonly defaultPath?: string;
  readonly waves: ReadonlyArray<ScenarioWaveRef>;
  readonly waveTrigger?: WaveTriggerConfig;
}

function resolveTrigger(scenario: ScenarioData | undefined): WaveTriggerConfig {
  return scenario?.waveTrigger ?? { kind: "manual" };
}

function cooldownForTrigger(trigger: WaveTriggerConfig): number | null {
  if (trigger.kind !== "auto" && trigger.kind !== "hybrid") return null;
  return trigger.cooldown ?? 0;
}

interface WaveGroup {
  readonly id: string;
  readonly enemy: string;
  readonly count: number;
  readonly interval?: number;
  readonly delay?: number;
}

interface WaveData {
  readonly groups: ReadonlyArray<WaveGroup>;
  readonly duration?: number;
  readonly reward?: number;
}

interface EnemyDef {
  readonly tags?: ReadonlyArray<string>;
  readonly stats: {
    readonly hp: number;
    readonly speed: number;
    readonly baseDamage: number;
  };
  readonly killReward: number;
  readonly attacks?: ReadonlyArray<unknown>;
}

function resolveGroupPaths(
  scenario: ScenarioData,
  waveRef: ScenarioWaveRef,
  groupId: string,
  mapPaths: ReadonlyArray<MapPath>,
): MapPath[] {
  const findById = (id: string): MapPath[] => {
    const p = mapPaths.find((mp) => mp.id === id);
    return p ? [p] : [];
  };
  const fromRef = (ref: string): MapPath[] =>
    ref === "*" ? [...mapPaths] : findById(ref);
  const fallback = (): MapPath[] =>
    typeof scenario.defaultPath === "string" ? findById(scenario.defaultPath) : [];

  const bindings = waveRef.pathBindings;
  if (bindings === undefined) return fallback();
  if (typeof bindings === "string") return fromRef(bindings);
  if (typeof bindings === "object" && bindings !== null) {
    const value = (bindings as Record<string, unknown>)[groupId];
    if (value === undefined) return fallback();
    if (typeof value === "string") return fromRef(value);
  }
  return fallback();
}

export const wavesPlugin: Plugin = {
  id: "waves",
  register(api) {
    // Components owned by the waves plugin.
    api.registerComponent({ name: "enemy", writableIn: PHASE_ORDER });
    api.registerComponent({ name: "health", writableIn: PHASE_ORDER });
    api.registerComponent({ name: "pathProgress", writableIn: [Phase.Simulation, Phase.Wave] });
    api.registerComponent({ name: "waveState", writableIn: PHASE_ORDER });

    api.onScenarioLoad((ctx: ActionContext) => {
      const scenario = (ctx.registry.scenarios as Record<string, ScenarioData>)[ctx.scenarioId];
      const trigger = resolveTrigger(scenario);
      ctx.world.spawn(STATE_ENTITY, {
        waveState: {
          nextIndex: 0,
          active: false,
          timeInWave: 0,
          sentByGroup: {} as Record<string, number>,
          // For auto / hybrid, the timer drives Wave 0 as well — players get a
          // pre-wave countdown UI window before the first spawn.
          cooldownRemaining: cooldownForTrigger(trigger),
        },
      });
    });

    // sendNextWave PlayerAction handler. The manual and hybrid WaveTriggers
    // accept this action; auto rejects it because auto Scenarios are
    // non-interactive at the wave-advance level.
    api.registerActionHandler({
      kind: "sendNextWave",
      handle(ctx) {
        const scenario = (ctx.registry.scenarios as Record<string, ScenarioData>)[ctx.scenarioId];
        if (!scenario) return actionFailure("NO_SCENARIO_LOADED", "Active scenario not found in registry.");
        const trigger = resolveTrigger(scenario);
        if (trigger.kind === "auto") {
          return actionFailure(
            "AUTO_TRIGGER_NOT_INTERACTIVE",
            "Auto-triggered Scenarios advance via cooldown; sendNextWave is not accepted.",
            "Use waveTrigger 'hybrid' or 'manual' to allow player-driven wave starts.",
          );
        }
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
          // Hybrid: a force-start clears the in-flight cooldown.
          cooldownRemaining: null,
        }));
        ctx.emit({
          kind: "waveStarted",
          tick: ctx.tickIndex,
          waveIndex: ws.nextIndex,
          trigger: trigger.kind,
        });
        return { ok: true, effect: { waveIndex: ws.nextIndex } };
      },
    });

    api.registerSystem({
      id: "waves/spawn",
      phase: Phase.Wave,
      reads: [],
      writes: [
        "waveState",
        "enemy",
        "position",
        "health",
        "pathProgress",
        "attacks",
        "engagement",
      ],
      run(ctx) {
        if (!ctx.scenarioId) return;
        const game = ctx.world.get(STATE_ENTITY);
        if (!game) return;
        let ws = game.components.get("waveState") as WaveState | undefined;
        if (!ws) return;

        const scenario = (ctx.registry.scenarios as Record<string, ScenarioData>)[ctx.scenarioId]!;
        const trigger = resolveTrigger(scenario);

        // Inactive: either advance the auto/hybrid cooldown timer or stay idle.
        // A non-null `cooldownRemaining` implies the trigger is auto/hybrid —
        // manual scenarios never set one.
        if (!ws.active) {
          if (ws.cooldownRemaining === null || ws.nextIndex >= scenario.waves.length) return;

          const remaining = ws.cooldownRemaining - ctx.dt;
          // Epsilon guard: 10 subtractions of 0.1 from 1.0 leaves ~1.4e-16,
          // not 0. Treating sub-nanosecond residue as "elapsed" makes the
          // trigger fire at the expected `cooldown / dt`-th tick instead of
          // one tick later.
          if (remaining > 1e-9) {
            ctx.world.mutate(STATE_ENTITY, "waveState", (v) => ({
              ...(v as WaveState),
              cooldownRemaining: remaining,
            }));
            return;
          }

          // Cooldown elapsed: activate the next wave and fall through into the
          // spawn loop so the first enemy appears on the same tick the wave
          // starts (parity with manual sendNextWave, which mutates state
          // between ticks).
          ws = { ...ws, active: true, cooldownRemaining: null, timeInWave: 0, sentByGroup: {} };
          ctx.world.mutate(STATE_ENTITY, "waveState", () => ws!);
          ctx.emit({
            kind: "waveStarted",
            tick: ctx.tickIndex,
            waveIndex: ws.nextIndex,
            trigger: trigger.kind,
          });
        }

        const map = (ctx.registry.maps as Record<string, MapData>)[scenario.map]!;
        const waveRef = scenario.waves[ws.nextIndex]!;
        const wave = (ctx.registry.waves as Record<string, WaveData>)[waveRef.id]!;

        const advanced = ws.timeInWave + ctx.dt;
        const newSent: Record<string, number> = { ...ws.sentByGroup };
        let totalSpawned = 0;
        let totalRequired = 0;

        for (const group of wave.groups) {
          const paths = resolveGroupPaths(scenario, waveRef, group.id, map.paths);
          const perPath = group.count;
          const required = perPath * paths.length;
          totalRequired += required;
          const already = newSent[group.id] ?? 0;
          const sinceDelay = advanced - (group.delay ?? 0);
          if (sinceDelay < 0) {
            totalSpawned += already;
            continue;
          }
          const interval = group.interval ?? 0;
          const shouldHavePerPath =
            interval === 0
              ? perPath
              : Math.min(perPath, Math.floor(sinceDelay / interval) + 1);
          const shouldHave = shouldHavePerPath * paths.length;
          for (let i = already; i < shouldHave; i++) {
            const pathIndex = Math.floor(i / shouldHavePerPath);
            const indexOnPath = i % shouldHavePerPath;
            const path = paths[pathIndex]!;
            const enemyDef = (ctx.registry.enemies as Record<string, EnemyDef>)[group.enemy]!;
            const spawnAt = path.waypoints[0]!;
            const enemyId = `enemy:${group.id}:${path.id}:${indexOnPath}:w${ws.nextIndex}:${ctx.tickIndex}`;
            const hasAttacks =
              Array.isArray(enemyDef.attacks) && enemyDef.attacks.length > 0;
            ctx.world.spawn(enemyId, {
              enemy: {
                archetype: group.enemy,
                killReward: enemyDef.killReward,
                waveIndex: ws.nextIndex,
                groupId: group.id,
                tags: enemyDef.tags ?? [],
              },
              position: { x: spawnAt.x, y: spawnAt.y },
              health: { hp: enemyDef.stats.hp },
              pathProgress: {
                pathId: path.id,
                wpIndex: 0,
                speed: enemyDef.stats.speed,
                baseDamage: enemyDef.stats.baseDamage,
              },
              ...(hasAttacks
                ? {
                    attacks: structuredClone(enemyDef.attacks) as unknown[],
                    engagement: {} as { target?: string },
                  }
                : {}),
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

        const allSpawnsDone = totalSpawned >= totalRequired;
        const thisWaveSurvivors = ctx.world.query({ all: ["enemy"] }).filter((e) => {
          const ec = e.components.get("enemy") as { waveIndex?: number } | undefined;
          return ec?.waveIndex === ws.nextIndex;
        });
        const naturalClear = allSpawnsDone && thisWaveSurvivors.length === 0;
        const duration = wave.duration;
        const forceClear = typeof duration === "number" && advanced >= duration;

        if (naturalClear || forceClear) {
          const surviving = thisWaveSurvivors.length;
          const reward = typeof wave.reward === "number" ? wave.reward : 0;
          ctx.emit({
            kind: "waveCleared",
            tick: ctx.tickIndex,
            waveIndex: ws.nextIndex,
            surviving,
            reward,
          });
          ctx.world.mutate(STATE_ENTITY, "waveState", (v) => {
            const cur = v as WaveState;
            const moreWaves = cur.nextIndex + 1 < scenario.waves.length;
            const nextCooldown = moreWaves ? cooldownForTrigger(trigger) : null;
            return {
              ...cur,
              active: false,
              nextIndex: cur.nextIndex + 1,
              cooldownRemaining: nextCooldown,
            };
          });
        }
      },
    });

    // wave-clear RewardKind: awards the wave's configured `reward` on each waveCleared event.
    api.registerReward({
      kind: "wave-clear",
      eventKind: "waveCleared",
      apply(ctx: RewardContext, event: GameEvent) {
        const reward = (event as { reward?: number }).reward;
        if (typeof reward !== "number" || reward === 0) return;
        const stateEntity = ctx.world.get(GOLD_ENTITY);
        const gold = stateEntity?.components.get("gold") as { amount: number } | undefined;
        if (!gold) return;
        const newAmount = gold.amount + reward;
        ctx.world.mutate(GOLD_ENTITY, "gold", () => ({ amount: newAmount }));
        ctx.emit({
          kind: "goldChanged",
          tick: ctx.tickIndex,
          delta: reward,
          amount: newAmount,
        });
      },
    });
  },
};
