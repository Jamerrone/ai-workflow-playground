import { actionFailure } from "../../kernel/action-result.js";
import {
  PHASE_ORDER,
  Phase,
  type AttackEffectContext,
  type AttackEffectDef,
  type GameEvent,
  type MoveRallyPointAction,
  type Plugin,
  type Position,
  type RewardContext,
  type UpgradeOpContext,
  type UpgradeOpDef,
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
    api.registerComponent({ name: "guardModifiers", writableIn: PHASE_ORDER });

    api.registerGameRule({ key: "enemyEngagementCap", default: 3 });

    const guardModifierOp: UpgradeOpDef = {
      kind: "guardModifier",
      validate(op) {
        const o = op as {
          attackId?: unknown;
          effectKind?: unknown;
          field?: unknown;
          delta?: unknown;
        };
        if (typeof o.attackId !== "string") return { ok: false, reason: "missing 'attackId'" };
        if (typeof o.effectKind !== "string") return { ok: false, reason: "missing 'effectKind'" };
        if (typeof o.field !== "string") return { ok: false, reason: "missing 'field'" };
        if (typeof o.delta !== "number") return { ok: false, reason: "missing numeric 'delta'" };
        return { ok: true };
      },
      apply(ctx: UpgradeOpContext) {
        const op = ctx.op as {
          attackId: string;
          effectKind: string;
          field: string;
          delta: number;
        };
        const existing =
          (ctx.tower.components.get("guardModifiers") as
            | ReadonlyArray<unknown>
            | undefined) ?? [];
        ctx.world.mutate(ctx.tower.id, "guardModifiers", () => [
          ...existing,
          { ...op },
        ]);
      },
    };
    api.registerUpgradeOp(guardModifierOp);

    const healEffect: AttackEffectDef = {
      kind: "heal",
      validate(effect) {
        const e = effect as { stats?: { amount?: unknown } };
        if (typeof e.stats?.amount !== "number" || e.stats.amount <= 0) {
          return { ok: false, reason: "stats.amount must be a positive number" };
        }
        return { ok: true };
      },
      apply(ctx: AttackEffectContext) {
        const amount = (ctx.effect.stats as { amount: number }).amount;
        for (const id of ctx.state.targets) {
          const target = ctx.world.get(id);
          const h = target?.components.get("health") as
            | { hp: number; max: number }
            | undefined;
          if (!h) continue;
          const delta = Math.min(amount, h.max - h.hp);
          if (delta <= 0) continue;
          const next = h.hp + delta;
          ctx.world.mutate(id, "health", () => ({ ...h, hp: next }));
          ctx.emit({
            kind: "entityHealed",
            tick: ctx.tickIndex,
            entity: id,
            delta,
            hp: next,
            source: ctx.fire.source.id,
            attackId: ctx.fire.attack.id,
            effectId: ctx.effect.id,
          });
        }
      },
    };
    api.registerAttackEffect(healEffect);

    api.registerEntityKind({
      kind: "guard",
      components: [
        "guard",
        "position",
        "health",
        "rallyPoint",
        "parent",
        "attacks",
        "cooldownTimer",
      ],
    });

    // Lazy id allocator: monotonically increasing per Tower, so a Guard that
    // dies and respawns later gets a new id (not reused).
    let nextGuardSerial = 0;
    const spawnGuard = (
      ctx: RewardContext,
      towerId: string,
      summon: SummonConfig,
      position: Position,
    ): string => {
      const guardId = `guard:${towerId}:${nextGuardSerial++}`;
      const summonsBucket = ctx.registry.summons as Record<
        string,
        { hp?: number; attacks?: ReadonlyArray<unknown> } | undefined
      >;
      const archetype = summonsBucket[summon.summons];
      const hp = archetype?.hp ?? 10;
      const attacks = archetype?.attacks ?? [];
      ctx.world.spawn(guardId, {
        guard: { archetype: summon.summons },
        position: { x: position.x, y: position.y },
        health: { hp, max: hp },
        rallyPoint: { x: position.x, y: position.y },
        parent: { tower: towerId },
        attacks: structuredClone(attacks) as unknown[],
        cooldownTimer: { remaining: 0 },
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

    // On waveCleared, every surviving Guard heals to max.
    api.registerReward({
      kind: "guards/wave-clear-heal",
      eventKind: "waveCleared",
      apply(ctx: RewardContext) {
        for (const g of ctx.world.query({ all: ["guard", "health"] })) {
          const h = g.components.get("health") as { hp: number; max: number };
          if (h.hp >= h.max) continue;
          ctx.world.mutate(g.id, "health", () => ({ ...h, hp: h.max }));
          ctx.emit({
            kind: "entityHealed",
            tick: ctx.tickIndex,
            entity: g.id,
            delta: h.max - h.hp,
            hp: h.max,
          });
        }
      },
    });

    // Guard death: Guards with hp ≤ 0 are destroyed and emit guardDied. The
    // emitted event feeds `guards/track-death` (per-Tower respawn cadence) and
    // any renderer subscribers.
    api.registerSystem({
      id: "guards/death",
      phase: Phase.Reward,
      reads: ["guard", "health", "parent"],
      writes: [],
      run(ctx) {
        const dead = ctx.world
          .query({ all: ["guard", "health"] })
          .filter((g) => (g.components.get("health") as { hp: number }).hp <= 0);
        for (const g of dead) {
          const parent = g.components.get("parent") as { tower: string };
          ctx.world.destroy(g.id);
          ctx.emit({
            kind: "guardDied",
            tick: ctx.tickIndex,
            guard: g.id,
            tower: parent.tower,
          });
        }
      },
    });

    // When a Tower is sold, every Guard parented to it is destroyed in the same
    // tick. No respawns: the Tower itself is gone, so there is no summonState
    // to advance.
    api.registerReward({
      kind: "guards/sell-despawn",
      eventKind: "towerSold",
      apply(ctx: RewardContext, event: GameEvent) {
        const towerId = (event as { tower?: string }).tower;
        if (!towerId) return;
        for (const g of ctx.world.query({ all: ["guard", "parent"] })) {
          const parent = g.components.get("parent") as { tower: string };
          if (parent.tower !== towerId) continue;
          ctx.world.destroy(g.id);
          ctx.emit({
            kind: "guardDespawned",
            tick: ctx.tickIndex,
            guard: g.id,
            tower: towerId,
            reason: "sold",
          });
        }
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

    // Guard combat: each Guard with an engagement and an off-cooldown Attack
    // whose range covers the engaged Enemy fires it. Damage flows through the
    // AttackEffect registry just like Tower attacks.
    api.registerSystem({
      id: "guards/attack",
      phase: Phase.Simulation,
      reads: ["guard", "engagement", "position", "attacks", "cooldownTimer"],
      writes: ["cooldownTimer"],
      after: ["guards/engagement"],
      run(ctx) {
        for (const g of ctx.world.query({
          all: ["guard", "engagement", "position", "attacks", "cooldownTimer"],
        })) {
          const eng = g.components.get("engagement") as { enemy?: string };
          if (!eng.enemy) continue;
          const enemy = ctx.world.get(eng.enemy);
          if (!enemy) continue;
          const cd = g.components.get("cooldownTimer") as { remaining: number };
          const newRemaining = Math.max(0, cd.remaining - ctx.dt);
          if (newRemaining > 0) {
            ctx.world.mutate(g.id, "cooldownTimer", () => ({
              remaining: newRemaining,
            }));
            continue;
          }
          const attacks = g.components.get("attacks") as ReadonlyArray<{
            id: string;
            stats: { range: number; cooldown: number };
            effects: ReadonlyArray<{
              kind: string;
              id?: string;
              stats?: Record<string, unknown>;
            }>;
          }>;
          const gPos = g.components.get("position") as Position;
          const ePos = enemy.components.get("position") as Position;
          const dx = ePos.x - gPos.x;
          const dy = ePos.y - gPos.y;
          const distSq = dx * dx + dy * dy;
          const fired = attacks.find(
            (a) => distSq <= a.stats.range * a.stats.range,
          );
          if (!fired) {
            ctx.world.mutate(g.id, "cooldownTimer", () => ({ remaining: 0 }));
            continue;
          }
          // Live-resolve modifiers from the parent Tower. Buffs are stored on
          // the Tower, not copied onto each Guard, so the same `guardModifiers`
          // entry applies to currently-living and yet-unborn Guards alike.
          const parent = g.components.get("parent") as { tower: string };
          const tower = ctx.world.get(parent.tower);
          const modifiers =
            (tower?.components.get("guardModifiers") as
              | ReadonlyArray<{
                  attackId: string;
                  effectKind: string;
                  field: string;
                  delta: number;
                }>
              | undefined) ?? [];
          const resolvedEffects = fired.effects.map((effect) => {
            const applicable = modifiers.filter(
              (m) => m.attackId === fired.id && m.effectKind === effect.kind,
            );
            if (applicable.length === 0) return effect;
            const stats = { ...(effect.stats ?? {}) } as Record<string, unknown>;
            for (const m of applicable) {
              const base = typeof stats[m.field] === "number" ? (stats[m.field] as number) : 0;
              stats[m.field] = base + m.delta;
            }
            return { ...effect, stats };
          });
          const fire = {
            source: { id: g.id, position: { ...gPos } },
            primaryTarget: { id: enemy.id, position: { ...ePos } },
            attack: { id: fired.id, stats: fired.stats },
            effects: resolvedEffects,
          };
          const state = { targets: [enemy.id], abort: false };
          for (const effect of resolvedEffects) {
            if (state.abort) break;
            const def = ctx.attackEffects.get(effect.kind);
            if (!def) continue;
            def.apply({
              tickIndex: ctx.tickIndex,
              dt: ctx.dt,
              world: ctx.world,
              registry: ctx.registry,
              fire,
              effect,
              state,
              emit: ctx.emit,
            });
          }
          ctx.world.mutate(g.id, "cooldownTimer", () => ({
            remaining: fired.stats.cooldown,
          }));
          ctx.emit({
            kind: "guardAttacked",
            tick: ctx.tickIndex,
            guard: g.id,
            enemy: enemy.id,
            attackId: fired.id,
          });
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
