import { actionFailure } from "../../kernel/action-result.js";
import {
  PHASE_ORDER,
  Phase,
  type GameEvent,
  type MoveRallyPointAction,
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

interface MapShape {
  readonly bases?: ReadonlyArray<{ readonly position: Position }>;
  readonly paths?: ReadonlyArray<{ readonly waypoints?: ReadonlyArray<Position> }>;
  readonly placementMode: { readonly kind: string };
}

function pathContains(
  pos: Position,
  waypoints: ReadonlyArray<Position>,
): boolean {
  for (let i = 0; i < waypoints.length - 1; i++) {
    const a = waypoints[i]!;
    const b = waypoints[i + 1]!;
    if (a.x === b.x && pos.x === a.x) {
      const lo = Math.min(a.y, b.y);
      const hi = Math.max(a.y, b.y);
      if (pos.y >= lo && pos.y <= hi) return true;
    } else if (a.y === b.y && pos.y === a.y) {
      const lo = Math.min(a.x, b.x);
      const hi = Math.max(a.x, b.x);
      if (pos.x >= lo && pos.x <= hi) return true;
    }
  }
  return false;
}

export const guardsPlugin: Plugin = {
  id: "guards",
  register(api) {
    api.registerComponent({ name: "guard", writableIn: PHASE_ORDER });
    api.registerComponent({ name: "summon", writableIn: PHASE_ORDER });
    api.registerComponent({ name: "summonState", writableIn: PHASE_ORDER });
    api.registerComponent({ name: "rallyPoint", writableIn: PHASE_ORDER });
    api.registerComponent({ name: "parent", writableIn: PHASE_ORDER });
    api.registerComponent({ name: "engagement", writableIn: PHASE_ORDER });

    api.registerGameRule({ key: "enemyEngagementCap", default: 3 });

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

    // Engagement assignment: each tick, each Guard picks the closest in-range
    // Enemy that hasn't already exceeded the `enemyEngagementCap` GameRule.
    // Iteration is in stable entity-insertion order, so the cap deterministically
    // selects the first N Guards (per Enemy) by id.
    api.registerSystem({
      id: "guards/engagement",
      phase: Phase.Simulation,
      reads: ["guard", "position", "engagement"],
      writes: ["engagement"],
      run(ctx) {
        const cap = (ctx.gameRules.get("enemyEngagementCap") as number) ?? 3;
        const summonsBucket = ctx.registry.summons as Record<
          string,
          { attacks?: ReadonlyArray<{ stats: { range: number } }> } | undefined
        >;
        const enemies = ctx.world.query({ all: ["enemy", "position"] });
        const engagedCount = new Map<string, number>();
        const guards = ctx.world.query({ all: ["guard", "position"] });
        for (const g of guards) {
          const gPos = g.components.get("position") as Position;
          const archetypeId = (g.components.get("guard") as { archetype: string })
            .archetype;
          const attacks = summonsBucket[archetypeId]?.attacks ?? [];
          const maxRange = attacks.reduce(
            (m, a) => Math.max(m, a.stats.range),
            0,
          );
          if (maxRange <= 0) {
            ctx.world.mutate(g.id, "engagement", () => ({ enemy: undefined }));
            continue;
          }
          let chosen: string | undefined;
          let chosenDistSq = Infinity;
          for (const e of enemies) {
            if ((engagedCount.get(e.id) ?? 0) >= cap) continue;
            const ePos = e.components.get("position") as Position;
            const dx = ePos.x - gPos.x;
            const dy = ePos.y - gPos.y;
            const dSq = dx * dx + dy * dy;
            if (dSq > maxRange * maxRange) continue;
            if (dSq < chosenDistSq) {
              chosen = e.id;
              chosenDistSq = dSq;
            }
          }
          if (chosen) {
            engagedCount.set(chosen, (engagedCount.get(chosen) ?? 0) + 1);
            ctx.world.mutate(g.id, "engagement", () => ({ enemy: chosen }));
          } else {
            ctx.world.mutate(g.id, "engagement", () => ({ enemy: undefined }));
          }
        }
      },
    });

    // Idle regen: Guards not currently engaged regenerate `idleRegen` HP/sec,
    // capped at their max. Runs after engagement so it reads fresh assignments.
    api.registerSystem({
      id: "guards/idle-regen",
      phase: Phase.Simulation,
      reads: ["guard", "engagement", "health"],
      writes: ["health"],
      after: ["guards/engagement"],
      run(ctx) {
        const summonsBucket = ctx.registry.summons as Record<
          string,
          { idleRegen?: number } | undefined
        >;
        for (const g of ctx.world.query({ all: ["guard", "health"] })) {
          const eng = g.components.get("engagement") as
            | { enemy?: string }
            | undefined;
          if (eng?.enemy) continue;
          const archetypeId = (g.components.get("guard") as { archetype: string })
            .archetype;
          const idleRegen = summonsBucket[archetypeId]?.idleRegen ?? 0;
          if (idleRegen <= 0) continue;
          const h = g.components.get("health") as { hp: number; max: number };
          if (h.hp >= h.max) continue;
          const next = Math.min(h.max, h.hp + idleRegen * ctx.dt);
          ctx.world.mutate(g.id, "health", () => ({ ...h, hp: next }));
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

    api.registerActionHandler({
      kind: "moveRallyPoint",
      handle(ctx, action) {
        const a = action as MoveRallyPointAction;
        const tower = ctx.world.get(a.tower);
        if (!tower || !tower.components.has("tower")) {
          return actionFailure("UNKNOWN_TOWER", `Tower entity '${a.tower}' not found.`);
        }
        const summon = tower.components.get("summon") as SummonConfig | undefined;
        if (!summon) {
          return actionFailure(
            "UNKNOWN_TOWER",
            `Tower '${a.tower}' has no summon Component.`,
          );
        }
        const towerPos = tower.components.get("position") as Position;
        const dx = a.position.x - towerPos.x;
        const dy = a.position.y - towerPos.y;
        if (dx * dx + dy * dy > summon.rallyPointRange * summon.rallyPointRange) {
          return actionFailure(
            "OUT_OF_RANGE",
            `Destination (${a.position.x},${a.position.y}) is beyond rallyPointRange ${summon.rallyPointRange} from Tower at (${towerPos.x},${towerPos.y}).`,
          );
        }
        const scenario = (ctx.registry.scenarios as Record<
          string,
          { map: string } | undefined
        >)[ctx.scenarioId];
        const map = scenario
          ? (ctx.registry.maps as Record<string, MapShape | undefined>)[scenario.map]
          : undefined;
        if (!map) {
          return actionFailure(
            "INVALID_RALLY_TILE",
            `Active map not found in registry.`,
          );
        }
        const onBase = (map.bases ?? []).some(
          (b) => b.position.x === a.position.x && b.position.y === a.position.y,
        );
        if (onBase) {
          return actionFailure(
            "INVALID_RALLY_TILE",
            `Destination (${a.position.x},${a.position.y}) is a Base tile.`,
          );
        }
        const towerOnTile = ctx.world
          .query({ all: ["tower", "position"] })
          .some((other) => {
            if (other.id === a.tower) return false;
            const p = other.components.get("position") as Position;
            return p.x === a.position.x && p.y === a.position.y;
          });
        if (towerOnTile) {
          return actionFailure(
            "INVALID_RALLY_TILE",
            `Destination (${a.position.x},${a.position.y}) is occupied by another Tower.`,
          );
        }
        const onBlocked = ctx.world
          .query({ all: ["blockedRegion"] })
          .some((be) => {
            const r = be.components.get("blockedRegion") as
              | { x: number; y: number; w: number; h: number }
              | undefined;
            if (!r) return false;
            return (
              a.position.x >= r.x &&
              a.position.x < r.x + r.w &&
              a.position.y >= r.y &&
              a.position.y < r.y + r.h
            );
          });
        if (onBlocked) {
          return actionFailure(
            "INVALID_RALLY_TILE",
            `Destination (${a.position.x},${a.position.y}) is inside a BlockedRegion.`,
          );
        }
        const onPath = (map.paths ?? []).some((p) =>
          pathContains(a.position, p.waypoints ?? []),
        );
        const placementMode = ctx.placementModes.get(map.placementMode.kind);
        const placementOk =
          placementMode?.validate(a.position, map, ctx.world).ok ?? false;
        if (!onPath && !placementOk) {
          return actionFailure(
            "INVALID_RALLY_TILE",
            `Destination (${a.position.x},${a.position.y}) is neither a Path tile nor a placeable tile.`,
          );
        }
        ctx.world.mutate(a.tower, "rallyPoint", () => ({
          x: a.position.x,
          y: a.position.y,
        }));
        ctx.emit({
          kind: "rallyPointMoved",
          tick: ctx.tickIndex,
          tower: a.tower,
          position: { x: a.position.x, y: a.position.y },
        });
        return {
          ok: true,
          effect: { tower: a.tower, position: { ...a.position } },
        };
      },
    });
  },
};
