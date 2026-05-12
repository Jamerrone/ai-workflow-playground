import {
  PHASE_ORDER,
  Phase,
  type AttackEffectConfig,
  type AttackEffectContext,
  type AttackEffectDef,
  type AttackEffectFire,
  type AttackEffectValidationResult,
  type Plugin,
  type Position,
} from "../../types.js";

const PENDING_FIRES_ENTITY = "attack-effects/pending";
const FIRES_COMPONENT = "pendingFires";
const STATUS_COMPONENT = "statusEffects";

interface PendingFire {
  readonly source: { id: string; position: Position };
  readonly primaryTarget: { id: string; position: Position };
  readonly attack: {
    id: string;
    stats: Record<string, unknown>;
    targetFilter?: { require?: string[]; exclude?: string[] };
  };
  readonly effects: ReadonlyArray<AttackEffectConfig>;
}

interface SlowStatus {
  readonly kind: "slow";
  readonly id?: string;
  readonly factor: number;
  remaining: number;
}

interface DotStatus {
  readonly kind: "dot";
  readonly id?: string;
  readonly damagePerTick: number;
  readonly interval: number;
  remaining: number;
  sinceLastTick: number;
}

type StatusEntry = SlowStatus | DotStatus;

function dist(a: Position, b: Position): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

function entityTags(world: AttackEffectContext["world"], id: string): readonly string[] {
  const enemy = world.get(id)?.components.get("enemy") as { tags?: readonly string[] } | undefined;
  return enemy?.tags ?? [];
}

function matchesFilter(
  tags: readonly string[],
  filter?: { require?: readonly string[]; exclude?: readonly string[] },
): boolean {
  if (!filter) return true;
  if (filter.require && filter.require.length > 0) {
    if (!filter.require.every((t) => tags.includes(t))) return false;
  }
  if (filter.exclude && filter.exclude.length > 0) {
    if (filter.exclude.some((t) => tags.includes(t))) return false;
  }
  return true;
}

function applyDamage(ctx: AttackEffectContext, targetId: string, amount: number): void {
  const e = ctx.world.get(targetId);
  if (!e) return;
  const hp = (e.components.get("health") as { hp: number } | undefined)?.hp;
  if (hp === undefined) return;
  ctx.world.mutate(targetId, "health", () => ({ hp: hp - amount }));
}

function isStatsObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function validateNumberStats(
  effect: unknown,
  fields: readonly string[],
): AttackEffectValidationResult {
  if (!isStatsObject(effect)) return { ok: false, reason: "not an object" };
  const stats = (effect as AttackEffectConfig).stats;
  if (!isStatsObject(stats)) return { ok: false, reason: "missing 'stats' object" };
  for (const f of fields) {
    if (typeof stats[f] !== "number") {
      return { ok: false, reason: `stats.${f} must be a number` };
    }
  }
  return { ok: true };
}

/** Damage: applies stats.amount to every target in ctx.state.targets. */
const damageEffect: AttackEffectDef = {
  kind: "damage",
  validate: (effect) => validateNumberStats(effect, ["amount"]),
  apply(ctx: AttackEffectContext): void {
    const amount = (ctx.effect.stats as { amount: number }).amount;
    for (const id of ctx.state.targets) {
      applyDamage(ctx, id, amount);
      ctx.emit({
        kind: "damageApplied",
        tick: ctx.tickIndex,
        source: ctx.fire.source.id,
        target: id,
        amount,
        attackId: ctx.fire.attack.id,
        effectId: ctx.effect.id,
      });
    }
  },
};

/** Splash: damages every enemy within stats.radius of the primary target's frozen position. */
const splashEffect: AttackEffectDef = {
  kind: "splash",
  validate: (effect) => validateNumberStats(effect, ["radius", "amount"]),
  apply(ctx: AttackEffectContext): void {
    const { radius, amount } = ctx.effect.stats as { radius: number; amount: number };
    const impact = ctx.fire.primaryTarget.position;
    const hit: string[] = [];
    const enemies = ctx.world.query({ all: ["enemy", "position", "health"] });
    for (const e of enemies) {
      const pos = e.components.get("position") as Position;
      if (dist(pos, impact) <= radius) {
        applyDamage(ctx, e.id, amount);
        hit.push(e.id);
      }
    }
    ctx.emit({
      kind: "splashApplied",
      tick: ctx.tickIndex,
      source: ctx.fire.source.id,
      impact: { ...impact },
      radius,
      amount,
      attackId: ctx.fire.attack.id,
      effectId: ctx.effect.id,
      targets: hit,
    });
  },
};

/** Slow: appends a slow status entry to each target's statusEffects. */
const slowEffect: AttackEffectDef = {
  kind: "slow",
  validate(effect) {
    const r = validateNumberStats(effect, ["factor", "duration"]);
    if (!r.ok) return r;
    const { factor } = (effect as { stats: { factor: number } }).stats;
    if (factor <= 0 || factor > 1) {
      return { ok: false, reason: "stats.factor must be in (0, 1]" };
    }
    return { ok: true };
  },
  apply(ctx: AttackEffectContext): void {
    const { factor, duration } = ctx.effect.stats as { factor: number; duration: number };
    for (const id of ctx.state.targets) {
      const status: SlowStatus = {
        kind: "slow",
        ...(ctx.effect.id !== undefined ? { id: ctx.effect.id } : {}),
        factor,
        remaining: duration,
      };
      addStatus(ctx, id, status);
      ctx.emit({
        kind: "slowApplied",
        tick: ctx.tickIndex,
        source: ctx.fire.source.id,
        target: id,
        factor,
        duration,
        attackId: ctx.fire.attack.id,
        effectId: ctx.effect.id,
      });
    }
  },
};

/** Dot: appends a dot status entry to each target. */
const dotEffect: AttackEffectDef = {
  kind: "dot",
  validate: (effect) => validateNumberStats(effect, ["damagePerTick", "interval", "duration"]),
  apply(ctx: AttackEffectContext): void {
    const { damagePerTick, interval, duration } = ctx.effect.stats as {
      damagePerTick: number;
      interval: number;
      duration: number;
    };
    for (const id of ctx.state.targets) {
      const status: DotStatus = {
        kind: "dot",
        ...(ctx.effect.id !== undefined ? { id: ctx.effect.id } : {}),
        damagePerTick,
        interval,
        remaining: duration,
        sinceLastTick: 0,
      };
      addStatus(ctx, id, status);
      ctx.emit({
        kind: "dotApplied",
        tick: ctx.tickIndex,
        source: ctx.fire.source.id,
        target: id,
        damagePerTick,
        interval,
        duration,
        attackId: ctx.fire.attack.id,
        effectId: ctx.effect.id,
      });
    }
  },
};

/** Pierce: damages up to stats.maxTargets nearest enemies on the source→primary axis. */
const pierceEffect: AttackEffectDef = {
  kind: "pierce",
  validate: (effect) => validateNumberStats(effect, ["amount", "maxTargets"]),
  apply: (ctx) => pierceLike(ctx, "pierceApplied"),
};

/** Line-pierce: long-line variant — same handler with the variant kind in events. */
const linePierceEffect: AttackEffectDef = {
  kind: "line-pierce",
  validate: (effect) => validateNumberStats(effect, ["amount", "maxTargets"]),
  apply: (ctx) => pierceLike(ctx, "linePierceApplied"),
};

function pierceLike(ctx: AttackEffectContext, eventKind: string): void {
  const { amount, maxTargets } = ctx.effect.stats as { amount: number; maxTargets: number };
  const src = ctx.fire.source.position;
  const primary = ctx.fire.primaryTarget.position;
  const dx = primary.x - src.x;
  const dy = primary.y - src.y;
  let axis: "x" | "y" | "diag";
  if (dx !== 0 && dy === 0) axis = "x";
  else if (dx === 0 && dy !== 0) axis = "y";
  else axis = "diag";
  const enemies = ctx.world.query({ all: ["enemy", "position", "health"] });
  const candidates = enemies
    .map((e) => ({ id: e.id, pos: e.components.get("position") as Position }))
    .filter(({ pos }) => {
      if (axis === "x") return pos.y === src.y && Math.sign(pos.x - src.x) === Math.sign(dx);
      if (axis === "y") return pos.x === src.x && Math.sign(pos.y - src.y) === Math.sign(dy);
      return false;
    })
    .sort((a, b) => dist(a.pos, src) - dist(b.pos, src))
    .slice(0, maxTargets);
  const hit: string[] = [];
  for (const c of candidates) {
    applyDamage(ctx, c.id, amount);
    hit.push(c.id);
  }
  ctx.emit({
    kind: eventKind,
    tick: ctx.tickIndex,
    source: ctx.fire.source.id,
    amount,
    maxTargets,
    attackId: ctx.fire.attack.id,
    effectId: ctx.effect.id,
    targets: hit,
  });
}

/** Bounce: chains hits to the nearest unstruck enemy up to stats.hops. */
const bounceEffect: AttackEffectDef = {
  kind: "bounce",
  validate: (effect) => validateNumberStats(effect, ["amount", "hops"]),
  apply(ctx: AttackEffectContext): void {
    const { amount, hops } = ctx.effect.stats as { amount: number; hops: number };
    const struck = new Set<string>([ctx.fire.primaryTarget.id]);
    applyDamage(ctx, ctx.fire.primaryTarget.id, amount);
    let from: Position = ctx.fire.primaryTarget.position;
    const enemies = ctx.world.query({ all: ["enemy", "position", "health"] });
    const chain: string[] = [ctx.fire.primaryTarget.id];
    for (let i = 0; i < hops; i++) {
      const next = enemies
        .filter((e) => !struck.has(e.id))
        .map((e) => ({ id: e.id, pos: e.components.get("position") as Position }))
        .sort((a, b) => dist(a.pos, from) - dist(b.pos, from))[0];
      if (!next) break;
      struck.add(next.id);
      applyDamage(ctx, next.id, amount);
      chain.push(next.id);
      from = next.pos;
    }
    ctx.emit({
      kind: "bounceApplied",
      tick: ctx.tickIndex,
      source: ctx.fire.source.id,
      amount,
      hops,
      attackId: ctx.fire.attack.id,
      effectId: ctx.effect.id,
      chain,
    });
  },
};

/**
 * Minimum-range: predicate. When the primary target is closer than stats.range to the
 * source, aborts the fire so subsequent effects do not apply.
 */
const minimumRangeEffect: AttackEffectDef = {
  kind: "minimum-range",
  validate: (effect) => validateNumberStats(effect, ["range"]),
  apply(ctx: AttackEffectContext): void {
    const { range } = ctx.effect.stats as { range: number };
    const d = dist(ctx.fire.source.position, ctx.fire.primaryTarget.position);
    if (d < range) {
      ctx.state.abort = true;
      ctx.emit({
        kind: "minimumRangeRejected",
        tick: ctx.tickIndex,
        source: ctx.fire.source.id,
        target: ctx.fire.primaryTarget.id,
        distance: d,
        range,
        attackId: ctx.fire.attack.id,
        effectId: ctx.effect.id,
      });
    }
  },
};

/**
 * Target-count: expands the running target list to up to stats.count nearest enemies that
 * match the attack's targetFilter. Subsequent effects apply to all of them.
 */
const targetCountEffect: AttackEffectDef = {
  kind: "target-count",
  validate: (effect) => validateNumberStats(effect, ["count"]),
  apply(ctx: AttackEffectContext): void {
    const { count } = ctx.effect.stats as { count: number };
    const from = ctx.fire.primaryTarget.position;
    const filter = ctx.fire.attack.targetFilter;
    const range = (ctx.fire.attack.stats as { range?: number }).range ?? Infinity;
    const enemies = ctx.world
      .query({ all: ["enemy", "position", "health"] })
      .filter((e) => matchesFilter(entityTags(ctx.world, e.id), filter))
      .filter((e) => dist(e.components.get("position") as Position, ctx.fire.source.position) <= range)
      .map((e) => ({ id: e.id, pos: e.components.get("position") as Position }))
      .sort((a, b) => dist(a.pos, from) - dist(b.pos, from))
      .slice(0, count);
    ctx.state.targets = enemies.map((e) => e.id);
    ctx.emit({
      kind: "targetCountApplied",
      tick: ctx.tickIndex,
      source: ctx.fire.source.id,
      count: ctx.state.targets.length,
      attackId: ctx.fire.attack.id,
      effectId: ctx.effect.id,
      targets: [...ctx.state.targets],
    });
  },
};

/**
 * Projectile-count: declarative — the projectiles plugin (when loaded) spawns N entities
 * per fire. Without it, emits a warning event and is a no-op (Loader will surface a
 * missing-plugin warning at config time in a future slice).
 */
const projectileCountEffect: AttackEffectDef = {
  kind: "projectile-count",
  validate: (effect) => validateNumberStats(effect, ["count"]),
  apply(ctx: AttackEffectContext): void {
    const { count } = ctx.effect.stats as { count: number };
    ctx.emit({
      kind: "projectileCountIntent",
      tick: ctx.tickIndex,
      source: ctx.fire.source.id,
      target: ctx.fire.primaryTarget.id,
      count,
      attackId: ctx.fire.attack.id,
      effectId: ctx.effect.id,
    });
  },
};

function addStatus(ctx: AttackEffectContext, targetId: string, entry: StatusEntry): void {
  const target = ctx.world.get(targetId);
  if (!target) return;
  const existing = (target.components.get(STATUS_COMPONENT) as StatusEntry[] | undefined) ?? [];
  ctx.world.mutate(targetId, STATUS_COMPONENT, () => [...existing, entry]);
}

export const attackEffectsPlugin: Plugin = {
  id: "attack-effects",
  register(api) {
    api.registerComponent({ name: FIRES_COMPONENT, writableIn: PHASE_ORDER });
    api.registerComponent({ name: STATUS_COMPONENT, writableIn: PHASE_ORDER });

    api.registerAttackEffect(damageEffect);
    api.registerAttackEffect(splashEffect);
    api.registerAttackEffect(slowEffect);
    api.registerAttackEffect(dotEffect);
    api.registerAttackEffect(pierceEffect);
    api.registerAttackEffect(linePierceEffect);
    api.registerAttackEffect(bounceEffect);
    api.registerAttackEffect(minimumRangeEffect);
    api.registerAttackEffect(targetCountEffect);
    api.registerAttackEffect(projectileCountEffect);

    api.onScenarioLoad((ctx) => {
      ctx.world.spawn(PENDING_FIRES_ENTITY, { [FIRES_COMPONENT]: { queue: [] as PendingFire[] } });
    });

    // Effect phase: drain pendingFires, dispatch each effect's handler in declared order.
    api.registerSystem({
      id: "attack-effects/apply",
      phase: Phase.Effect,
      reads: ["pendingFires"],
      writes: ["pendingFires", "health", "statusEffects"],
      run(ctx) {
        const stateEntity = ctx.world.get(PENDING_FIRES_ENTITY);
        const state = stateEntity?.components.get(FIRES_COMPONENT) as
          | { queue: PendingFire[] }
          | undefined;
        if (!state || state.queue.length === 0) return;
        const queue = state.queue;
        ctx.world.mutate(PENDING_FIRES_ENTITY, FIRES_COMPONENT, () => ({ queue: [] }));

        for (const fire of queue) {
          const efState = { targets: [fire.primaryTarget.id], abort: false };
          for (const effect of fire.effects) {
            const def = ctx.attackEffects.get(effect.kind);
            if (!def) {
              ctx.emit({
                kind: "attackEffectUnknown",
                tick: ctx.tickIndex,
                source: fire.source.id,
                effectKind: effect.kind,
                attackId: fire.attack.id,
              });
              continue;
            }
            const ec: AttackEffectContext = {
              tickIndex: ctx.tickIndex,
              dt: ctx.dt,
              world: ctx.world,
              registry: ctx.registry,
              fire: fire as AttackEffectFire,
              effect,
              state: efState,
              emit: ctx.emit,
            };
            def.apply(ec);
            if (efState.abort) break;
          }
        }
      },
    });

    // Effect phase, after apply: decrement status durations and apply dot ticks.
    api.registerSystem({
      id: "attack-effects/statusTick",
      phase: Phase.Effect,
      after: ["attack-effects/apply"],
      reads: ["statusEffects", "health"],
      writes: ["statusEffects", "health"],
      run(ctx) {
        const targets = ctx.world.query({ all: [STATUS_COMPONENT] });
        for (const t of targets) {
          const entries = t.components.get(STATUS_COMPONENT) as StatusEntry[];
          if (entries.length === 0) continue;
          const next: StatusEntry[] = [];
          for (const entry of entries) {
            if (entry.kind === "dot") {
              const sinceLastTick = entry.sinceLastTick + ctx.dt;
              const remaining = entry.remaining - ctx.dt;
              let nextSince = sinceLastTick;
              if (sinceLastTick >= entry.interval) {
                const hp = (t.components.get("health") as { hp: number } | undefined)?.hp;
                if (hp !== undefined) {
                  ctx.world.mutate(t.id, "health", () => ({ hp: hp - entry.damagePerTick }));
                }
                ctx.emit({
                  kind: "dotTicked",
                  tick: ctx.tickIndex,
                  target: t.id,
                  amount: entry.damagePerTick,
                  effectId: entry.id,
                });
                nextSince = sinceLastTick - entry.interval;
              }
              if (remaining > 0) {
                next.push({ ...entry, remaining, sinceLastTick: nextSince });
              }
            } else {
              const remaining = entry.remaining - ctx.dt;
              if (remaining > 0) next.push({ ...entry, remaining });
            }
          }
          ctx.world.mutate(t.id, STATUS_COMPONENT, () => next);
        }
      },
    });
  },
};

