import {
  PHASE_ORDER,
  Phase,
  type GameEvent,
  type Plugin,
  type Position,
  type RewardContext,
} from "../../types.js";

interface SummonConfig {
  readonly summons: string;
  readonly maxCount: number;
  readonly respawnCooldown: number;
  readonly rallyPointRange: number;
}

interface SummonState {
  aliveGuards: string[];
  respawnTimer: number;
  pendingRespawns: number;
}

export const guardsPlugin: Plugin = {
  id: "guards",
  register(api) {
    api.registerComponent({ name: "guard", writableIn: PHASE_ORDER });
    api.registerComponent({ name: "summon", writableIn: PHASE_ORDER });
    api.registerComponent({ name: "summonState", writableIn: PHASE_ORDER });
    api.registerComponent({ name: "rallyPoint", writableIn: PHASE_ORDER });
    api.registerComponent({ name: "parent", writableIn: PHASE_ORDER });

    api.registerEntityKind({
      kind: "guard",
      components: ["guard", "position", "health", "rallyPoint", "parent"],
    });

    // Lazy id allocator: monotonically increasing per Tower, so a Guard that
    // dies and respawns later gets a new id (not reused).
    let nextGuardSerial = 0;
    const spawnGuard = (
      ctx: RewardContext | { world: import("../../kernel/world.js").World; tickIndex: number; emit(e: GameEvent): void },
      towerId: string,
      summon: SummonConfig,
      position: Position,
    ): string => {
      const guardId = `guard:${towerId}:${nextGuardSerial++}`;
      ctx.world.spawn(guardId, {
        guard: { archetype: summon.summons },
        position: { x: position.x, y: position.y },
        health: { hp: 10, max: 10 },
        rallyPoint: { x: position.x, y: position.y },
        parent: { tower: towerId },
      });
      ctx.emit({
        kind: "guardSpawned",
        tick: ctx.tickIndex,
        guard: guardId,
        tower: towerId,
        archetype: summon.summons,
        position: { x: position.x, y: position.y },
      });
      return guardId;
    };

    // On Tower placement, every Tower carrying a `summon` Component spawns its
    // initial cohort of Guards immediately at the Tower's position.
    api.registerReward({
      kind: "guards/initial-spawn",
      eventKind: "towerPlaced",
      apply(ctx: RewardContext, event: GameEvent) {
        const towerId = (event as { tower?: string }).tower;
        const position = (event as { position?: Position }).position;
        if (!towerId || !position) return;
        const tower = ctx.world.get(towerId);
        const summon = tower?.components.get("summon") as SummonConfig | undefined;
        if (!summon) return;

        const aliveGuards: string[] = [];
        for (let i = 0; i < summon.maxCount; i++) {
          aliveGuards.push(spawnGuard(ctx, towerId, summon, position));
        }
        const state: SummonState = {
          aliveGuards,
          respawnTimer: 0,
          pendingRespawns: 0,
        };
        ctx.world.mutate(towerId, "summonState", () => state);
        ctx.world.mutate(towerId, "rallyPoint", () => ({
          x: position.x,
          y: position.y,
        }));
      },
    });

    // On Guard death, mark its slot for sequential respawn on the parent Tower.
    api.registerReward({
      kind: "guards/track-death",
      eventKind: "guardDied",
      apply(ctx: RewardContext, event: GameEvent) {
        const guardId = (event as { guard?: string }).guard;
        const towerId = (event as { tower?: string }).tower;
        if (!guardId || !towerId) return;
        const tower = ctx.world.get(towerId);
        const state = tower?.components.get("summonState") as SummonState | undefined;
        if (!state) return;
        const next: SummonState = {
          aliveGuards: state.aliveGuards.filter((id) => id !== guardId),
          respawnTimer: state.respawnTimer,
          pendingRespawns: state.pendingRespawns + 1,
        };
        ctx.world.mutate(towerId, "summonState", () => next);
      },
    });

    // Continuous Euclidean locomotion: each Guard advances `speed * dt` along
    // the straight-line vector toward its parent Tower's current Rally Point.
    // Clamps to the destination once within one step.
    api.registerSystem({
      id: "guards/locomotion",
      phase: Phase.Simulation,
      reads: ["guard", "position", "parent"],
      writes: ["position"],
      run(ctx) {
        const summonsBucket = ctx.registry.summons as Record<
          string,
          { speed?: number } | undefined
        >;
        for (const g of ctx.world.query({ all: ["guard", "position", "parent"] })) {
          const parent = g.components.get("parent") as { tower: string };
          const tower = ctx.world.get(parent.tower);
          const rally = tower?.components.get("rallyPoint") as Position | undefined;
          if (!rally) continue;
          const pos = g.components.get("position") as Position;
          const archetypeId = (g.components.get("guard") as { archetype: string })
            .archetype;
          const speed = summonsBucket[archetypeId]?.speed ?? 0;
          if (speed <= 0) continue;
          const dx = rally.x - pos.x;
          const dy = rally.y - pos.y;
          const distSq = dx * dx + dy * dy;
          if (distSq === 0) continue;
          const step = speed * ctx.dt;
          if (step * step >= distSq) {
            ctx.world.mutate(g.id, "position", () => ({ x: rally.x, y: rally.y }));
            continue;
          }
          const dist = Math.sqrt(distSq);
          ctx.world.mutate(g.id, "position", () => ({
            x: pos.x + (dx / dist) * step,
            y: pos.y + (dy / dist) * step,
          }));
        }
      },
    });

    // Per-Tower respawn timer: advances only when there's a pending respawn.
    // On expiry, exactly one Guard spawns and the timer resets — one-at-a-time
    // even when multiple Guards died in the same tick.
    api.registerSystem({
      id: "guards/respawn-timer",
      phase: Phase.Simulation,
      reads: ["tower", "summon", "summonState", "position"],
      writes: ["summonState"],
      run(ctx) {
        const towers = ctx.world.query({ all: ["summon", "summonState", "position"] });
        for (const t of towers) {
          const summon = t.components.get("summon") as SummonConfig;
          const state = t.components.get("summonState") as SummonState;
          if (state.pendingRespawns <= 0) continue;
          const position = t.components.get("position") as Position;
          const newTimer = state.respawnTimer + ctx.dt;
          if (newTimer < summon.respawnCooldown) {
            ctx.world.mutate(t.id, "summonState", () => ({
              ...state,
              respawnTimer: newTimer,
            }));
            continue;
          }
          const guardId = spawnGuard(ctx, t.id, summon, position);
          ctx.world.mutate(t.id, "summonState", () => ({
            aliveGuards: [...state.aliveGuards, guardId],
            respawnTimer: 0,
            pendingRespawns: state.pendingRespawns - 1,
          }));
        }
      },
    });
  },
};
