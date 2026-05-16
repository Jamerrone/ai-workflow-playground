import { actionFailure } from "../../kernel/action-result.js";
import {
  PHASE_ORDER,
  Phase,
  type AttackEffectContext,
  type AttackEffectDef,
  type AttackSelectionCandidate,
  type AttackSelectionStrategyConfig,
  type GameEvent,
  type MoveRallyPointAction,
  type Plugin,
  type Position,
  type RewardContext,
  type SystemContext,
  type TargetingCandidate,
  type TargetingStrategyConfig,
  type UpgradeOpContext,
  type UpgradeOpDef,
} from "../../types.js";
import {
  type AttackData,
  matchesFilter,
  entityTags,
} from "./attack-shared.js";
import {
  validateRallyPoint,
  type RallyPointFailureReason,
  type RallyPointMapShape,
} from "./rally-point.js";

declare module "../../types.js" {
  interface GameEvents {
    guardSpawned: { kind: "guardSpawned"; tick: number; guard: string; tower: string; archetype: string; position: Position };
    entityHealed: { kind: "entityHealed"; tick: number; entity: string; delta: number; hp: number; source?: string; attackId?: string; effectId?: string };
    guardDied: { kind: "guardDied"; tick: number; guard: string; tower: string };
    guardDespawned: { kind: "guardDespawned"; tick: number; guard: string; tower: string; reason: string };
    guardAttacked: { kind: "guardAttacked"; tick: number; guard: string; enemy: string; attackId: string };
    rallyPointMoved: { kind: "rallyPointMoved"; tick: number; tower: string; position: Position };
  }
}

const DEFAULT_TARGETING: TargetingStrategyConfig = { kind: "closest-to-base" };
const DEFAULT_ATTACK_SELECTION: AttackSelectionStrategyConfig = {
  kind: "declaration-order",
};

interface GuardModifier {
  readonly attackId: string;
  readonly effectKind: string;
  readonly field: string;
  readonly delta: number;
}

function applyGuardModifiers(
  attacks: ReadonlyArray<AttackData>,
  modifiers: ReadonlyArray<GuardModifier>,
): AttackData[] {
  if (modifiers.length === 0) return [...attacks];
  return attacks.map((attack) => {
    const effects = attack.effects.map((effect) => {
      const applicable = modifiers.filter(
        (m) => m.attackId === attack.id && m.effectKind === effect.kind,
      );
      if (applicable.length === 0) return effect;
      const stats = { ...(effect.stats ?? {}) } as Record<string, unknown>;
      for (const m of applicable) {
        const base = typeof stats[m.field] === "number" ? (stats[m.field] as number) : 0;
        stats[m.field] = base + m.delta;
      }
      return { ...effect, stats };
    });
    return { ...attack, effects };
  });
}

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

const RALLY_FAILURE_CODE: Record<RallyPointFailureReason, string> = {
  "out-of-range": "OUT_OF_RANGE",
  "base-tile": "INVALID_RALLY_TILE",
  "tower-occupied": "INVALID_RALLY_TILE",
  "blocked-region": "INVALID_RALLY_TILE",
  "not-placeable": "INVALID_RALLY_TILE",
};

function rallyFailureMessage(
  reason: RallyPointFailureReason,
  position: Position,
  towerPosition: Position,
  rallyPointRange: number,
): string {
  switch (reason) {
    case "out-of-range":
      return `Destination (${position.x},${position.y}) is beyond rallyPointRange ${rallyPointRange} from Tower at (${towerPosition.x},${towerPosition.y}).`;
    case "base-tile":
      return `Destination (${position.x},${position.y}) is a Base tile.`;
    case "tower-occupied":
      return `Destination (${position.x},${position.y}) is occupied by another Tower.`;
    case "blocked-region":
      return `Destination (${position.x},${position.y}) is inside a BlockedRegion.`;
    case "not-placeable":
      return `Destination (${position.x},${position.y}) is neither a Path tile nor a placeable tile.`;
  }
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
        "engagement",
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
        { hp?: number; attacks?: ReadonlyArray<unknown>; tags?: ReadonlyArray<string> } | undefined
      >;
      const archetype = summonsBucket[summon.summons];
      const hp = archetype?.hp ?? 10;
      const attacks = archetype?.attacks ?? [];
      const tags = archetype?.tags ?? [];
      ctx.world.spawn(guardId, {
        guard: { archetype: summon.summons, tags: [...tags] },
        position: { x: position.x, y: position.y },
        health: { hp, max: hp },
        rallyPoint: { x: position.x, y: position.y },
        parent: { tower: towerId },
        attacks: structuredClone(attacks) as unknown[],
        cooldownTimer: { remaining: 0 },
        engagement: {} as { target?: string },
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

    // Sticky engagement: a Guard's `engagement.target` persists across ticks
    // until the target dies or leaves range of every Attack. Only then does
    // (re-)selection run — which picks among in-range Enemies whose tags pass
    // any of the Guard's resolved (with modifiers applied) Attack
    // `targetFilter`s, via the parent Tower's TargetingStrategy.
    //
    // The `enemyEngagementCap` GameRule is enforced on the Enemy side
    // (`enemies/engagement`), not here: the cap counts how many Enemies engage
    // a given Guard, not the inverse.
    api.registerSystem({
      id: "guards/engagement",
      phase: Phase.Simulation,
      reads: ["guard", "position", "engagement", "parent", "attacks"],
      writes: ["engagement"],
      run(ctx) {
        const guards = ctx.world.query({
          all: ["guard", "position", "engagement"],
        });
        for (const g of guards) {
          const gPos = g.components.get("position") as Position;
          const parent = g.components.get("parent") as
            | { tower: string }
            | undefined;
          const tower = parent ? ctx.world.get(parent.tower) : undefined;
          const baseAttacks =
            (g.components.get("attacks") as
              | ReadonlyArray<AttackData>
              | undefined) ?? [];
          const modifiers =
            (tower?.components.get("guardModifiers") as
              | ReadonlyArray<GuardModifier>
              | undefined) ?? [];
          const attacks = applyGuardModifiers(baseAttacks, modifiers);
          if (attacks.length === 0) {
            const cur = g.components.get("engagement") as
              | { target?: string }
              | undefined;
            if (cur?.target) {
              ctx.world.mutate(g.id, "engagement", () => ({}));
            }
            continue;
          }

          // Check existing engagement for stickiness.
          const cur = g.components.get("engagement") as
            | { target?: string }
            | undefined;
          if (cur?.target) {
            const target = ctx.world.get(cur.target);
            if (target) {
              const tPos = target.components.get("position") as
                | Position
                | undefined;
              if (tPos) {
                const dx = tPos.x - gPos.x;
                const dy = tPos.y - gPos.y;
                const distSq = dx * dx + dy * dy;
                // Still in range of any Attack? Then keep the engagement.
                const inRange = attacks.some(
                  (a) => distSq <= a.stats.range * a.stats.range,
                );
                if (inRange) continue;
              }
            }
            // Target gone or out of range — clear before re-selecting.
            ctx.world.mutate(g.id, "engagement", () => ({}));
          }

          // (Re-)select via the parent Tower's TargetingStrategy across
          // candidates passing any Attack's targetFilter and in any Attack's
          // range.
          const enemies = ctx.world.query({ all: ["enemy", "position"] });
          const eligible = enemies.filter((e) => {
            const ePos = e.components.get("position") as Position;
            const dx = ePos.x - gPos.x;
            const dy = ePos.y - gPos.y;
            const distSq = dx * dx + dy * dy;
            const tags = entityTags(e.components);
            return attacks.some((a) => {
              if (distSq > a.stats.range * a.stats.range) return false;
              return matchesFilter(tags, a.targetFilter);
            });
          });
          if (eligible.length === 0) continue;

          const targetingConfig: TargetingStrategyConfig =
            (tower?.components.get("targeting") as TargetingStrategyConfig | undefined) ??
            DEFAULT_TARGETING;
          const strategyDef = ctx.targetingStrategies.get(targetingConfig.kind);
          if (!strategyDef) continue;

          // basePosition: Guards live under their parent Tower; the Tower's
          // first-base reference is unimportant for sticky engagement (the
          // `closest-to-base` strategy still works because it sorts by distance
          // to a fixed point — here we pass the Guard's own position as a
          // reasonable fallback when no scenario base is available; built-in
          // strategies that need a real base run on Towers, not Guards, in
          // typical Scenarios).
          const scenario = ctx.scenarioId
            ? (ctx.registry.scenarios as Record<string, { map?: string } | undefined>)[
                ctx.scenarioId
              ]
            : undefined;
          const map = scenario?.map
            ? (ctx.registry.maps as Record<
                string,
                { bases?: ReadonlyArray<{ position: Position }> } | undefined
              >)[scenario.map]
            : undefined;
          const basePosition = map?.bases?.[0]?.position ?? { ...gPos };

          const picked = strategyDef.select({
            source: { id: g.id, position: { ...gPos } },
            basePosition,
            eligible: eligible as TargetingCandidate[],
            config: targetingConfig,
          });
          if (picked) {
            ctx.world.mutate(g.id, "engagement", () => ({ target: picked.id }));
          }
        }
      },
    });

    // Guard combat: each Guard with an engagement.target advances its cooldown
    // and fires one Attack — chosen by the parent Tower's AttackSelectionStrategy
    // — through `ctx.fireAttack`. Damage / status / etc. resolution flows
    // through the `attack-effects/apply` System the same way Tower fires do.
    api.registerSystem({
      id: "guards/attack",
      phase: Phase.Simulation,
      reads: [
        "guard",
        "engagement",
        "position",
        "attacks",
        "cooldownTimer",
        "parent",
        "guardModifiers",
      ],
      writes: ["cooldownTimer", "pendingFires"],
      after: ["guards/engagement"],
      run(ctx: SystemContext) {
        for (const g of ctx.world.query({
          all: ["guard", "engagement", "position", "attacks", "cooldownTimer"],
        })) {
          const eng = g.components.get("engagement") as { target?: string };
          if (!eng.target) continue;
          const enemy = ctx.world.get(eng.target);
          if (!enemy) continue;
          const cd = g.components.get("cooldownTimer") as { remaining: number };
          const newRemaining = Math.max(0, cd.remaining - ctx.dt);
          ctx.world.mutate(g.id, "cooldownTimer", () => ({ remaining: newRemaining }));
          if (newRemaining > 0) continue;

          const parent = g.components.get("parent") as { tower: string };
          const tower = ctx.world.get(parent.tower);
          const modifiers =
            (tower?.components.get("guardModifiers") as
              | ReadonlyArray<GuardModifier>
              | undefined) ?? [];
          const baseAttacks =
            (g.components.get("attacks") as
              | ReadonlyArray<AttackData>
              | undefined) ?? [];
          const attacks = applyGuardModifiers(baseAttacks, modifiers);

          const gPos = g.components.get("position") as Position;
          const ePos = enemy.components.get("position") as Position;
          const targetTags = entityTags(enemy.components);
          const dx = ePos.x - gPos.x;
          const dy = ePos.y - gPos.y;
          const distSq = dx * dx + dy * dy;

          const eligible: AttackSelectionCandidate[] = attacks
            .filter((a) => distSq <= a.stats.range * a.stats.range)
            .filter((a) => matchesFilter(targetTags, a.targetFilter))
            .map((a) => ({
              id: a.id,
              stats: a.stats,
              ...(a.targetFilter !== undefined ? { targetFilter: a.targetFilter } : {}),
              effects: a.effects,
            }));
          if (eligible.length === 0) continue;

          const towerArchetypeId = tower
            ? (tower.components.get("tower") as { archetype: string }).archetype
            : undefined;
          const towerDef = towerArchetypeId
            ? (ctx.registry.towers as Record<
                string,
                { attackSelection?: AttackSelectionStrategyConfig } | undefined
              >)[towerArchetypeId]
            : undefined;
          const selectionConfig = towerDef?.attackSelection ?? DEFAULT_ATTACK_SELECTION;
          const selectionDef = ctx.attackSelectionStrategies.get(selectionConfig.kind);
          if (!selectionDef) continue;
          const chosen = selectionDef.select({
            source: { id: g.id, position: { ...gPos } },
            eligible,
            config: selectionConfig,
            attackEffects: ctx.attackEffects,
            world: ctx.world,
            resolveTarget: () => ({ id: enemy.id, position: { ...ePos } }),
          });
          if (!chosen) continue;

          const fired = ctx.fireAttack({
            attacker: g.id,
            attack: {
              id: chosen.id,
              stats: chosen.stats,
              effects: chosen.effects,
              ...(chosen.targetFilter !== undefined
                ? { targetFilter: chosen.targetFilter }
                : {}),
            },
            primaryTarget: enemy.id,
          });
          if (!fired) continue;

          ctx.emit({
            kind: "guardAttacked",
            tick: ctx.tickIndex,
            guard: g.id,
            enemy: enemy.id,
            attackId: chosen.id,
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
            | { target?: string }
            | undefined;
          if (eng?.target) continue;
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
        const scenario = (ctx.registry.scenarios as Record<
          string,
          { map: string } | undefined
        >)[ctx.scenarioId];
        const map = scenario
          ? (ctx.registry.maps as Record<string, RallyPointMapShape | undefined>)[
              scenario.map
            ]
          : undefined;
        if (!map) {
          return actionFailure(
            "INVALID_RALLY_TILE",
            `Active map not found in registry.`,
          );
        }
        const result = validateRallyPoint({
          position: a.position,
          towerPosition: towerPos,
          towerId: a.tower,
          rallyPointRange: summon.rallyPointRange,
          map,
          world: ctx.world,
          placementModes: ctx.placementModes,
        });
        if (!result.ok) {
          return actionFailure(
            RALLY_FAILURE_CODE[result.reason],
            rallyFailureMessage(
              result.reason,
              a.position,
              towerPos,
              summon.rallyPointRange,
            ),
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
